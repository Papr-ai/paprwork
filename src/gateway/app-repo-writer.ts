/**
 * app-repo-writer — sole pusher for per-app GitHub repos (Sync V3 Phase 2).
 *
 * Auth: user Papr API key (X-API-Key). Writer validates namespace ACL via memory
 * server RepoRegistry — same pattern as cloud-app-host calling memory with a
 * server-side key, except desktop calls writer directly with the user's key.
 *
 * Local dev:
 *   PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001
 *   GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALL_ID
 *   npm run start:app-repo-writer
 */

import dotenv from "dotenv";
import { resolve } from "path";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  getAppRepoWriterService,
  WriterRepoNotFoundError,
} from "./services/appRepoWriter/AppRepoWriterService.js";

dotenv.config({ path: resolve(process.cwd(), ".env.local") });

const PORT = Number(process.env.PORT ?? process.env.PAPR_APP_REPO_WRITER_PORT ?? 8789);

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.header("X-API-Key")?.trim();
  if (!apiKey) {
    res.status(401).json({ error: "X-API-Key required" });
    return;
  }
  (req as Request & { paprApiKey: string }).paprApiKey = apiKey;
  next();
}

const app = express();
app.use(express.json({ limit: "32mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "app-repo-writer" });
});

app.get(
  "/apps/:appId/head",
  requireApiKey,
  async (req, res) => {
    const appId = String(req.params.appId);
    const apiKey = (req as Request & { paprApiKey: string }).paprApiKey;
    try {
      const head = await getAppRepoWriterService().getHead(appId, apiKey);
      res.json(head);
    } catch (err) {
      if (err instanceof WriterRepoNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: (err as Error).message.slice(0, 300) });
    }
  },
);

app.post(
  "/apps/:appId/ops",
  requireApiKey,
  async (req, res) => {
    const appId = String(req.params.appId);
    const apiKey = (req as Request & { paprApiKey: string }).paprApiKey;
    try {
      const outcome = await getAppRepoWriterService().postOps(
        appId,
        apiKey,
        req.body,
      );
      if (!outcome.ok) {
        res.status(outcome.status).json(outcome.body);
        return;
      }
      res.json(outcome.response);
    } catch (err) {
      if (err instanceof WriterRepoNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: (err as Error).message.slice(0, 300) });
    }
  },
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[AppRepoWriter] listening on http://0.0.0.0:${PORT}`);
});
