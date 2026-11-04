#!/usr/bin/env node
/**
 * Bundle the Focus page for apps.papr.ai (ui/web/main.tsx → dist/resources/focus-web/focus.{js,css}).
 * The cloud app host serves these at /focus/_/ (cloudAppFocusPage.ts). Run by the Dockerfile and build:gateway.
 */
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [path.join(root, "ui/web/main.tsx")],
  outfile: path.join(root, "dist/resources/focus-web/focus.js"),
  bundle: true, minify: true, format: "esm", target: "es2022", jsx: "automatic", legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
  logLevel: "warning",
});
console.log("[focus-web] built dist/resources/focus-web/focus.{js,css}");
