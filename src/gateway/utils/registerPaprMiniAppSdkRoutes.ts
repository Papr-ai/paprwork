/**
 * Serve the shared mini-app SDK from resources (bundled on demand).
 */

import type { Express, Request, Response } from "express";
import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  MINI_APP_SDK_MODULES,
  type MiniAppSdkFormat,
} from "../../resources/mini-app-sdk/sdk-manifest.js";
import {
  prebuiltMiniAppSdkBundlePath,
  resolveMiniAppSdkDir,
} from "./miniAppSdkSource.js";

/**
 * SDK sources must live OUTSIDE app.asar in packaged builds — see
 * `resolveMiniAppSdkDir`, which this route and the HTML inliner share so the
 * asar reasoning lives in exactly one place.
 */
const SDK_DIR = resolveMiniAppSdkDir();

function sendSdkJavaScript(res: Response, code: string, cacheImmutable: boolean): void {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    cacheImmutable ? "public, max-age=31536000, immutable" : "public, max-age=60",
  );
  res.send(code);
}

async function serveSdkFile(
  sdkFileName: string,
  _req: Request,
  res: Response,
  format: MiniAppSdkFormat = "iife",
): Promise<void> {
  try {
    const prebuiltPath = prebuiltMiniAppSdkBundlePath(sdkFileName);
    if (existsSync(prebuiltPath)) {
      sendSdkJavaScript(res, readFileSync(prebuiltPath, "utf8"), true);
      return;
    }

    const filePath = path.join(SDK_DIR, sdkFileName);
    const esbuild = await import("esbuild");
    const result = await esbuild.build({
      entryPoints: [filePath],
      bundle: true,
      format,
      platform: "browser",
      target: "es2020",
      write: false,
      sourcemap: "inline",
    });
    const code = result.outputFiles?.[0]?.text;
    if (!code) {
      res.status(500).send("SDK bundle failed");
      return;
    }
    sendSdkJavaScript(res, code, false);
  } catch (err) {
    res.status(500).send((err as Error).message);
  }
}

export function registerPaprMiniAppSdkRoutes(app: Express): void {
  for (const module of MINI_APP_SDK_MODULES) {
    app.get(module.route, (req, res) =>
      serveSdkFile(module.file, req, res, module.format),
    );
  }
}
