/**
 * Model-call routes for papr_llm.
 *
 *   POST /api/llm/complete        loopback only: desktop jobs/backend actions,
 *                                 and backend handlers in the cloud agent sandbox
 *   POST /internal/llm/complete   cloud agent gateway only, service key: the memory
 *                                 server relays cloud script jobs (GKE pods) here
 *                                 with the run's credentials resolved from the vault
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { isLoopbackRequest } from "../../utils/isLoopbackRequest.js";
import type { ModelCallCredential, ModelCallInput } from "./modelCall.js";

const MAX_CHARS = 2_000_000;
/** Ceiling on output tokens per call (guards a runaway job loop). */
export const MAX_OUTPUT_TOKENS = 32_000;

type Parsed = { input: Omit<ModelCallInput, "signal"> } | { status: number; error: string };

export function parseModelCallBody(raw: unknown): Parsed {
  const b = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  const prompt = str("prompt");
  if (!prompt?.trim()) return { status: 400, error: "prompt is required" };
  const size = [prompt, str("system"), str("context")].reduce((n, s) => n + (s?.length ?? 0), 0);
  if (size > MAX_CHARS) return { status: 413, error: `prompt + system + context exceed ${MAX_CHARS} characters` };
  const provider = str("provider");
  if (provider && provider !== "anthropic" && provider !== "openai") {
    return { status: 400, error: "provider must be 'anthropic' or 'openai'" };
  }
  const cacheTtl = str("cacheTtl");
  if (cacheTtl && cacheTtl !== "5m" && cacheTtl !== "1h") return { status: 400, error: "cacheTtl must be '5m' or '1h'" };
  const maxTokens = typeof b.maxTokens === "number" && b.maxTokens > 0 ? Math.min(Math.floor(b.maxTokens), MAX_OUTPUT_TOKENS) : undefined;
  return {
    input: {
      prompt,
      system: str("system"),
      context: str("context"),
      provider: provider as "anthropic" | "openai" | undefined,
      model: str("model"),
      maxTokens,
      webSearch: b.webSearch === true,
      cache: b.cache !== false,
      cacheTtl: cacheTtl as "5m" | "1h" | undefined,
      temperature: typeof b.temperature === "number" ? b.temperature : undefined,
    },
  };
}

function errorStatus(message: string): number {
  return /no (api key|credential)|not connected|connect your|token not found|no provider|no claude or chatgpt/i.test(message) ? 401 : 502;
}

async function handle(req: Request, res: Response, credentials?: ModelCallCredential[]): Promise<void> {
  const parsed = parseModelCallBody(req.body);
  if ("error" in parsed) {
    res.status(parsed.status).json({ error: parsed.error });
    return;
  }
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  try {
    const { callModel } = await import("./modelCall.js");
    res.json(await callModel({ ...parsed.input, credentials, signal: abort.signal }));
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    res.status(errorStatus(message)).json({ error: message });
  }
}

export function registerModelCallRoutes(app: Express): void {
  app.post("/api/llm/complete", async (req: Request, res: Response) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: "Model calls are only available to jobs and backend actions on this machine." });
      return;
    }
    await handle(req, res);
  });
}

/** Cloud agent gateway: the memory server's relay for cloud script jobs. */
export function registerInternalModelCallRoute(app: Express, requireGatewayAuth: RequestHandler): void {
  app.post("/internal/llm/complete", requireGatewayAuth, async (req: Request, res: Response) => {
    const raw = (req.body ?? {}) as { credentials?: unknown };
    const credentials = Array.isArray(raw.credentials)
      ? (raw.credentials.filter(
          (c): c is ModelCallCredential =>
            !!c && typeof c === "object" && typeof (c as ModelCallCredential).token === "string" &&
            typeof (c as ModelCallCredential).provider === "string",
        ) as ModelCallCredential[])
      : [];
    if (!credentials.length) {
      res.status(401).json({ error: "No Claude or ChatGPT credential is connected for this account" });
      return;
    }
    await handle(req, res, credentials);
  });
}
