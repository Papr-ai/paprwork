#!/usr/bin/env node
/**
 * Bundle the Focus page for apps.papr.ai (ui/web/main.tsx → dist/resources/focus-web/focus.{js,css}).
 * The cloud app host serves these at /focus/_/ (cloudAppFocusPage.ts). Run by the Dockerfile and build:gateway.
 */
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Desktop-only modules the Focus components import but never use on the web (guarded by focusEnv.web).
 * The cloud app host image copies only ui/web + ui/components/Focus, so the real files are not there:
 * swap them for empty stand-ins instead of bundling the desktop gateway client.
 */
const WEB_STUBS = {
  "stores/noticeStore": "export const useNoticeStore = (sel) => sel({ notices: [] });",
};
const desktopOnlyStubs = {
  name: "desktop-only-stubs",
  setup(b) {
    const filter = new RegExp(`(${Object.keys(WEB_STUBS).map((k) => k.replace("/", "\\/")).join("|")})$`);
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: "web-stub" }));
    b.onLoad({ filter: /.*/, namespace: "web-stub" }, (args) => {
      const key = Object.keys(WEB_STUBS).find((k) => args.path.endsWith(k));
      return { contents: WEB_STUBS[key], loader: "js" };
    });
  },
};
await build({
  entryPoints: [path.join(root, "ui/web/main.tsx")],
  outfile: path.join(root, "dist/resources/focus-web/focus.js"),
  bundle: true, minify: true, format: "esm", target: "es2022", jsx: "automatic", legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
  logLevel: "warning",
  plugins: [desktopOnlyStubs],
});
console.log("[focus-web] built dist/resources/focus-web/focus.{js,css}");
