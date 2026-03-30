import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { resolve } from "path";

// Read version from root package.json
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf-8")
);
const appVersion = packageJson.version;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: "html-transform",
      transformIndexHtml(html) {
        return html.replace(
          '<meta name="viewport"',
          `<meta name="app-version" content="${appVersion}" />\n    <meta name="viewport"`
        );
      },
    },
  ],
  define: {
    // Expose environment variables to client
    'import.meta.env.VITE_REQUIRE_PAPR_AUTH': JSON.stringify(process.env.REQUIRE_PAPR_AUTH || 'false'),
  },
  base: "./", // Use relative paths for Electron
  resolve: {
    // CRITICAL: Do not resolve from parent node_modules
    preserveSymlinks: true,
    dedupe: ["react", "react-dom", "zustand"],
  },
  optimizeDeps: {
    // Force Vite to only bundle these specific deps from ui/node_modules
    include: ["react", "react/jsx-runtime", "react-dom", "zustand"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    // Optimize bundle size with esbuild (faster than terser)
    minify: "esbuild",
    // Increase chunk size warning limit (679KB gzipped to 187KB is acceptable)
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // Split vendor chunks for better caching and smaller main bundle
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          state: ["zustand"],
          editor: [
            "@tiptap/react",
            "@tiptap/starter-kit",
            "@tiptap/extension-underline",
            "@tiptap/extension-placeholder",
            "@tiptap/extension-bubble-menu",
            "@tiptap/suggestion",
            "tiptap-markdown",
            "tippy.js",
          ],
          syntax: ["react-syntax-highlighter"],
          markdown: ["react-markdown", "remark-math", "rehype-katex"],
        },
      },
      // Mark everything except our UI deps as external
      external: (id) => {
        // Allow our UI dependencies
        if (
          id === "react" ||
          id === "react-dom" ||
          id === "zustand" ||
          id.startsWith("react/") ||
          id.startsWith("react-dom/")
        ) {
          return false;
        }
        // Everything else is external (shouldn't be bundled)
        return (
          id.includes("@mastra") ||
          id.includes("@ai-sdk") ||
          id.includes("@papr") ||
          id.includes("better-sqlite3") ||
          id.includes("express") ||
          id.includes("fs-extra") ||
          id.includes("uuid") ||
          id.includes("node:") ||
          id === "crypto" ||
          id === "fs" ||
          id === "path"
        );
      },
    },
  },
});
