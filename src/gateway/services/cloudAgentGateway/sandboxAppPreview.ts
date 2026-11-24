/**
 * Serve mini-apps from the run's workspace at /apps/{appId}/… on the sandbox
 * loopback API, the same URL shape as the desktop gateway. The headless
 * preview host (webview_* tools, validate_app runtime check) loads apps from
 * here, so the agent sees exactly what its files render — before publishing.
 *
 * Mirrors the desktop static route's essentials: dist/ bundle, the bundled
 * entry rewrite, platform base styles, and the /__papr__/ SDK modules.
 */
import fs from "fs/promises";
import path from "path";
import type express from "express";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { getMiniAppContentType } from "../../utils/miniAppStaticAssets.js";

const APP_ID = /^[0-9a-zA-Z_-]{1,64}$/;

function appDir(appId: string): string {
  return path.join(getPaprRoot(), "apps", appId);
}

async function renderIndexHtml(dir: string, html: string): Promise<string> {
  const { preferBundledEntryInHtml } = await import("../../utils/miniAppBuild.js");
  const { injectMiniAppBaseStyles } = await import("../../utils/miniAppBaseStyles.js");
  const { injectMiniAppNativeDialogShim } = await import(
    "../../utils/injectMiniAppNativeDialogShim.js"
  );
  let out = await preferBundledEntryInHtml(html, dir);
  out = injectMiniAppBaseStyles(out);
  out = injectMiniAppNativeDialogShim(out);
  return out;
}

async function transpileTs(file: string, source: string): Promise<string> {
  const esbuild = await import("esbuild");
  const result = await esbuild.transform(source, {
    loader: file.endsWith(".tsx") ? "tsx" : "ts",
    format: "esm",
    target: "es2020",
  });
  return result.code;
}

export function registerSandboxAppPreviewRoutes(app: express.Express): void {
  // /__papr__/*.js SDK modules (papr-job-events, native dialog shim, …).
  void import("../../utils/registerPaprMiniAppSdkRoutes.js")
    .then(({ registerPaprMiniAppSdkRoutes }) => registerPaprMiniAppSdkRoutes(app))
    .catch((err) => console.warn("[SandboxPreview] SDK routes unavailable:", err));

  app.get(/^\/apps\/([^/]+)\/?(.*)$/, async (req, res) => {
    const appId = req.params[0] ?? "";
    const requested = decodeURIComponent(req.params[1] || "index.html");
    if (!APP_ID.test(appId) || requested.includes("..") || path.isAbsolute(requested)) {
      res.status(400).send("Bad path");
      return;
    }
    const dir = appDir(appId);
    const file = path.join(dir, requested);
    if (!file.startsWith(dir + path.sep)) {
      res.status(400).send("Bad path");
      return;
    }
    const ext = path.extname(requested).toLowerCase();
    try {
      if (requested === "index.html") {
        const html = await fs.readFile(file, "utf8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.send(await renderIndexHtml(dir, html));
        return;
      }
      if ((ext === ".ts" || ext === ".tsx") && !requested.startsWith("dist/")) {
        const code = await transpileTs(requested, await fs.readFile(file, "utf8"));
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.send(code);
        return;
      }
      await fs.access(file);
      res.setHeader("Content-Type", getMiniAppContentType(ext));
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") {
        res.status(404).send("Not found");
        return;
      }
      res.status(500).send(err instanceof Error ? err.message : String(err));
    }
  });
}
