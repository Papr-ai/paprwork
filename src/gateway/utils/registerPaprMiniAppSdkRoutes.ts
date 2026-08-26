/**
 * Serve the shared mini-app SDK from resources (bundled on demand).
 */

import type { Express, Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  MINI_APP_SDK_MODULES,
  type MiniAppSdkFormat,
} from "../../resources/mini-app-sdk/sdk-manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SDK_DIR = path.join(__dirname, "../../resources/mini-app-sdk");

async function serveSdkFile(
  sdkFileName: string,
  _req: Request,
  res: Response,
  format: MiniAppSdkFormat = "iife",
): Promise<void> {
  try {
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
    res.setHeader(
      "Content-Type",
      format === "esm"
        ? "application/javascript; charset=utf-8"
        : "application/javascript; charset=utf-8",
    );
    res.setHeader("Cache-Control", "public, max-age=60");
    res.send(code);
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
