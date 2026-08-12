/**
 * Serve the shared mini-app SDK from resources (transpiled on demand).
 */

import type { Express, Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SDK_DIR = path.join(__dirname, "../../resources/mini-app-sdk");

async function serveSdkFile(
  sdkFileName: string,
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const filePath = path.join(SDK_DIR, sdkFileName);
    const content = await fs.readFile(filePath, "utf8");
    const { transpileMiniAppTypeScript } = await import(
      "./miniAppTranspile.js"
    );
    const result = await transpileMiniAppTypeScript(content, sdkFileName);
    if (!result.success || !result.code) {
      res.status(500).send(result.message ?? "Transpile failed");
      return;
    }
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.send(result.code);
  } catch (err) {
    res.status(500).send((err as Error).message);
  }
}

export function registerPaprMiniAppSdkRoutes(app: Express): void {
  app.get("/__papr__/papr-job-events.ts", (req, res) =>
    serveSdkFile("papr-job-events.ts", req, res),
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
  app.get("/__papr__/papr-files.js", (req, res) =>
    serveSdkFile("papr-files.ts", req, res),
  );
  app.get("/__papr__/papr-markdown.js", (req, res) =>
    serveSdkFile("papr-markdown.ts", req, res),
  );
  app.get("/__papr__/papr-agent-chat-plan.js", (req, res) =>
    serveSdkFile("papr-agent-chat-plan.ts", req, res),
  );
}
