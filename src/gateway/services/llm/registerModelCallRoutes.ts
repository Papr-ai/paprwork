/**
 * POST /api/llm/complete — one model call for jobs and backend actions
 * (papr_llm.complete). Loopback only: the caller is a process on this machine
 * (desktop job / backend handler, or the cloud sandbox's own runner).
 */

import type { Express, Request, Response } from "express";
import { isLoopbackRequest } from "../../utils/isLoopbackRequest.js";

const MAX_CHARS = 2_000_000;

export function registerModelCallRoutes(app: Express): void {
  app.post("/api/llm/complete", async (req: Request, res: Response) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: "Model calls are only available to jobs and backend actions on this machine." });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
    const prompt = str("prompt");
    if (!prompt?.trim()) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    const size = [prompt, str("system"), str("context")].reduce((n, s) => n + (s?.length ?? 0), 0);
    if (size > MAX_CHARS) {
      res.status(413).json({ error: `prompt + system + context exceed ${MAX_CHARS} characters` });
      return;
    }
    const provider = str("provider");
    if (provider && provider !== "anthropic" && provider !== "openai") {
      res.status(400).json({ error: "provider must be 'anthropic' or 'openai'" });
      return;
    }
    const cacheTtl = str("cacheTtl");
    if (cacheTtl && cacheTtl !== "5m" && cacheTtl !== "1h") {
      res.status(400).json({ error: "cacheTtl must be '5m' or '1h'" });
      return;
    }

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      const { callModel } = await import("./modelCall.js");
      const result = await callModel({
        prompt,
        system: str("system"),
        context: str("context"),
        provider: provider as "anthropic" | "openai" | undefined,
        model: str("model"),
        maxTokens: typeof b.maxTokens === "number" ? b.maxTokens : undefined,
        webSearch: b.webSearch === true,
        cache: b.cache !== false,
        cacheTtl: cacheTtl as "5m" | "1h" | undefined,
        temperature: typeof b.temperature === "number" ? b.temperature : undefined,
        signal: abort.signal,
      });
      res.json(result);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const status = /no (api key|credential)|not connected|connect your|token not found|no provider/i.test(message) ? 401 : 502;
      res.status(status).json({ error: message });
    }
  });
}
