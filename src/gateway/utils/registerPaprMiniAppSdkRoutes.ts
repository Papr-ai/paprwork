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

export function registerPaprMiniAppSdkRoutes(app: Express): void {
  app.get("/__papr__/papr-job-events.ts", async (_req: Request, res: Response) => {
    try {
      const filePath = path.join(SDK_DIR, "papr-job-events.ts");
      const content = await fs.readFile(filePath, "utf8");
      const { transpileMiniAppTypeScript } = await import(
        "./miniAppTranspile.js"
      );
      const result = await transpileMiniAppTypeScript(content, "papr-job-events.ts");
      if (!result.success || !result.code) {
        res.status(500).send(result.message ?? "Transpile failed");
        return;
      }
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(result.code);
    } catch (err) {
      res.status(500).send((err as Error).message);
    }
  });
}
