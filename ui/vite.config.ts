import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { resolve } from "path";

// Read version from root package.json
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf-8")
);
const appVersion = packageJson.version;

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
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
    'import.meta.env.VITE_REQUIRE_PAPR_AUTH': JSON.stringify(
      env.VITE_REQUIRE_PAPR_AUTH || 'false'
    ),
  },
  base: "./",
  resolve: {
    preserveSymlinks: true,
    dedupe: ["react", "react-dom", "zustand"],
    alias: {
      react: resolve(__dirname, "../node_modules/react"),
      "react-dom": resolve(__dirname, "../node_modules/react-dom"),
    },
  },
  optimizeDeps: {
    include: ["react", "react/jsx-runtime", "react-dom", "zustand"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    minify: "esbuild",
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react-dom/") || id.includes("node_modules/react/")) {
            return "react-vendor";
          }
          if (id.includes("node_modules/zustand/")) {
            return "state";
          }
          if (
            id.includes("node_modules/@tiptap/") ||
            id.includes("node_modules/tiptap-markdown") ||
            id.includes("node_modules/tippy.js") ||
            id.includes("node_modules/prosemirror") ||
            id.includes("node_modules/@prosemirror") ||
            id.includes("node_modules/@remirror")
          ) {
            return "editor";
          }
          if (
            id.includes("node_modules/react-syntax-highlighter/") ||
            id.includes("node_modules/refractor/") ||
            id.includes("node_modules/prismjs/") ||
            id.includes("node_modules/highlight.js/") ||
            id.includes("node_modules/lowlight/")
          ) {
            return "syntax";
          }
          if (
            id.includes("node_modules/react-markdown/") ||
            id.includes("node_modules/remark-math/") ||
            id.includes("node_modules/rehype-katex/") ||
            id.includes("node_modules/katex/") ||
            id.includes("node_modules/remark-gfm/")
          ) {
            return "markdown";
          }
        },
      },
      external: (id) => {
        if (
          id === "react" ||
          id === "react-dom" ||
          id === "zustand" ||
          id.startsWith("react/") ||
          id.startsWith("react-dom/")
        ) {
          return false;
        }
        return (
          id.includes("@mastra") ||
          id.includes("@ai-sdk") ||
          id.includes("@papr") ||
          id.includes("better-sqlite3") ||
          id.includes("express") ||
          id.includes("fs-extra") ||
          id.includes("node:") ||
          id === "crypto" ||
          id === "fs" ||
          id === "path"
        );
      },
    },
  },
};
});
