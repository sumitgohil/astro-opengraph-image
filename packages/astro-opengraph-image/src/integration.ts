import type { AstroIntegration } from "astro";
import { stringify } from "devalue";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Font } from "satori";
import type { Plugin } from "vite";
import { parse } from 'node-html-parser';
import { convert } from "./convert";
import type { AstroGlobal } from "astro";

export interface Options {
  background: string;
  width: number;
  height: number;
  scale: number;
  fonts: Font[];
  site?: string;
}

export default function ogImage(options: Options): AstroIntegration {
  return {
    name: "og-image",
    hooks: {
      "astro:config:setup"({
        injectRoute,
        addDevToolbarApp,
        updateConfig,
        command,
        config,
      }) {
        // if we're in dev, or have an ssr adapter, we are allowed to emit
        // the _og route. in the case of a truly static build, injectRoute will fail
        // but is not necessary given we'll traverse the output anyway.
        if (command !== "dev" && !config.adapter) return;

        injectRoute({
          pattern: "/_og",
          entrypoint: new URL("./route.ts", import.meta.url),
          prerender: false,
        });
        addDevToolbarApp({
          id: "og-image",
          name: "OpenGraph Image",
          icon: "image",
          entrypoint: new URL("./app.ts", import.meta.url),
        });
        updateConfig({
          vite: {
            plugins: [vitePluginVirtualOptions(options)],
          },
        });
      },
      async "astro:build:done"({ assets, dir }) {
        const ogDir = new URL("_og/", dir);

        await Promise.all(
          [...assets]
            .flatMap(([, files]) => files)
            .map((file) =>
              transformFilePostBuild(fileURLToPath(file), options, ogDir),
            ),
        );
      },
    },
  };
}

function vitePluginVirtualOptions(options: Options): Plugin {
  return {
    name: "og-image:config",
    resolveId(id) {
      if (id === "og-image:config") {
        return "\0og-image:config";
      }
    },
    load(id) {
      if (id === "\0og-image:config") {
        return `export default ${JSON.stringify(stringify(options))}`;
      }
    },
  };
}

async function transformFilePostBuild(
  file: string,
  options: Options,
  ogDir: URL,
) {
  try {
    // Skip non-HTML files
    if (!file.endsWith(".html") && !file.endsWith(".htm")) return;
    
    const input = await readFile(file, "utf-8");
    
    // Parse the HTML content using node-html-parser
    const root = parse(input);
    
    // Find all meta tags with og:image property
    const metaTags = root.querySelectorAll('meta[property="og:image"]');
    
    let modified = false;
    
    // Process each meta tag
    for (const meta of metaTags) {
      const content = meta.getAttribute("content");
      if (!content) continue;
      
      try {
        // Handle relative URLs by checking if content starts with / or _
        let url;
        try {
          url = new URL(content);
        } catch (e) {
          // If URL creation fails, assume it's a relative path and create with a base
          // Use Astro.site as the base URL
          const site = options.site || "https://example.com"; // Fallback if site is not provided
          url = new URL(content, site);
        }
        
        if (url.pathname !== "/_og" && !url.pathname.startsWith("/_og/")) continue;
        
        // For /_og/filename.png pattern, we should extract the filename and skip conversion
        if (url.pathname.startsWith("/_og/")) {
          const imageName = url.pathname.substring(5); // Remove the /_og/ prefix
          if (imageName) {
            // Just copy the reference, no need to regenerate the image
            const site = options.site || "https://example.com"; // Fallback if site is not provided
            meta.setAttribute("content", new URL(`/_og/${imageName}`, site).href);
            modified = true;
            continue;
          }
        }
        
        const png = await convert(url, options);
        if (!png) continue;
        
        // Check if a custom filename is provided
        const customFilename = url.searchParams.get("filename");
        let imageName: string;
        
        if (customFilename) {
          // Use the custom filename but ensure it ends with .png
          imageName = customFilename.endsWith(".png") 
            ? customFilename 
            : `${customFilename}.png`;
        } else {
          // Default behavior: generate hash-based filename
          const hash = createHash("sha256").update(png).digest("base64url");
          imageName = `${hash}.png`;
        }
        
        await mkdir(ogDir, { recursive: true });
        await writeFile(new URL(imageName, ogDir), png);
        
        const site = options.site || "https://example.com"; // Fallback if site is not provided
        meta.setAttribute("content", new URL(`/_og/${imageName}`, site).href);
        modified = true;
      } catch (err) {
        console.error(`Error processing meta tag:`, err);
      }
    }
    
    // Only write back to the file if changes were made
    if (modified) {
      await writeFile(file, root.toString());
    }
  } catch (error) {
    console.error(`Error processing file ${file}:`, error);
  }
}
