/**
 * Serve the shared mini-app SDK from resources (bundled on demand).
 */

import type { Express, Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SDK_DIR = path.join(__dirname, "../../resources/mini-app-sdk");

type SdkBundleFormat = "iife" | "esm";

async function serveSdkFile(
  sdkFileName: string,
  _req: Request,
  res: Response,
  format: SdkBundleFormat = "iife",
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
  // ESM — imported by bundled mini-apps (dist/app.js leaves /__papr__/ external).
  app.get("/__papr__/papr-job-events.ts", (req, res) =>
    serveSdkFile("papr-job-events.ts", req, res, "esm"),
  );
  app.get("/__papr__/papr-preview-lifecycle.ts", (req, res) =>
    serveSdkFile("papr-preview-lifecycle.ts", req, res, "esm"),
  );
  app.get("/__papr__/papr-auth-guard.js", (req, res) =>
    serveSdkFile("papr-auth-guard.ts", req, res),
  );
  app.get("/__papr__/papr-auth-ui.js", (req, res) =>
    serveSdkFile("papr-auth-ui.ts", req, res),
  );
  app.get("/__papr__/papr-version-check.js", (req, res) =>
    serveSdkFile("papr-version-check.ts", req, res),
  );
  app.get("/__papr__/papr-agent-chat.js", (req, res) =>
    serveSdkFile("papr-agent-chat.ts", req, res),
  );
  // Served from the same place in both runtimes, so `papr.files.*` is one
  // import that behaves identically on desktop and apps.papr.ai.
  //
  // ESM, not the iife default: this module is consumed as
  // `import { papr } from '/__papr__/papr-files.js'` and exports no window
  // global, so an iife bundle exposes nothing. The import then throws
  // "does not provide an export named 'papr'" — a module-level SyntaxError
  // that aborts the whole app bundle, so the mini-app renders blank.
  app.get("/__papr__/papr-files.js", (req, res) =>
    serveSdkFile("papr-files.ts", req, res, "esm"),
  );
  app.get("/__papr__/papr-markdown.js", (req, res) =>
    serveSdkFile("papr-markdown.ts", req, res),
  );
  app.get("/__papr__/papr-agent-chat-plan.js", (req, res) =>
    serveSdkFile("papr-agent-chat-plan.ts", req, res),
  );
}
