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

/**
 * SDK sources must live OUTSIDE app.asar in packaged builds.
 *
 * esbuild bundles these files, and esbuild is a native binary running as a
 * separate process. The asar virtual filesystem is patched into Electron's
 * `fs` module only — a child process sees `app.asar` as a single opaque
 * file, so every bundle failed with:
 *
 *   Could not resolve ".../app.asar/dist/resources/mini-app-sdk/papr-job-events.ts"
 *
 * Mini-apps import `/__papr__/papr-job-events.ts`, so that 500 meant the app
 * bundle never evaluated and rendered blank — with an empty console, because
 * a failed module fetch logs nothing.
 *
 * `dist/resources/mini-app-sdk/**` is in electron-builder `asarUnpack`, so
 * prefer the unpacked copy whenever this file is loaded from inside an asar.
 * Do NOT probe with fs.existsSync to choose: Electron's patched `fs` reports
 * the in-asar path as readable, which is exactly the path esbuild cannot use.
 */
function resolveSdkDir(): string {
  const bundled = path.join(__dirname, "../../resources/mini-app-sdk");
  return bundled.includes(`app.asar${path.sep}`)
    ? bundled.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    : bundled;
}

const SDK_DIR = resolveSdkDir();

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
