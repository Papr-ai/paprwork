import express from "express";
import http from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authsFromCredentials } from "../../src/gateway/services/llm/modelCall.js";
import {
  MAX_OUTPUT_TOKENS,
  parseModelCallBody,
  registerInternalModelCallRoute,
} from "../../src/gateway/services/llm/registerModelCallRoutes.js";

describe("authsFromCredentials (cloud relay)", () => {
  it("keeps order, maps codex to openai and drops unknown providers", () => {
    const auths = authsFromCredentials(
      [
        { provider: "openai-codex", authType: "oauth", token: " tok-o " },
        { provider: "google", authType: "apiKey", token: "g" },
        { provider: "anthropic", authType: "apiKey", token: "papr", usePaprProxy: true },
      ],
      "openai",
      "gpt-5-6-luna",
    );
    expect(auths.map((a) => [a.provider, a.model, a.authType, a.apiKey, !!a.usePaprProxy])).toEqual([
      ["openai", "gpt-5-6-luna", "oauth", "tok-o", false],
      ["anthropic", "claude-sonnet-4-6", "apiKey", "papr", true],
    ]);
  });
});

describe("parseModelCallBody", () => {
  it("caps max tokens and validates fields", () => {
    const ok = parseModelCallBody({ prompt: "hi", maxTokens: 10_000_000 });
    expect("input" in ok && ok.input.maxTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(parseModelCallBody({ prompt: " " })).toMatchObject({ status: 400 });
    expect(parseModelCallBody({ prompt: "x", provider: "gemini" })).toMatchObject({ status: 400 });
  });
});

describe("POST /internal/llm/complete", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const auth = vi.fn((req: any, res: any, next: any) =>
      req.header("X-Cloud-Agent-Gateway-Key") === "k" ? next() : res.status(401).json({ error: "unauthorized" }),
    );
    registerInternalModelCallRoute(app, auth);
    await new Promise<void>((r) => (server = app.listen(0, "127.0.0.1", () => r())));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (body: unknown, key = "k") =>
    fetch(`${base}/internal/llm/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Cloud-Agent-Gateway-Key": key },
      body: JSON.stringify(body),
    });

  it("requires the service key", async () => {
    expect((await post({ prompt: "hi", credentials: [{ provider: "openai", authType: "apiKey", token: "t" }] }, "bad")).status).toBe(401);
  });

  it("refuses a call without credentials (never falls back to this machine's keys)", async () => {
    const r = await post({ prompt: "hi" });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toMatch(/No Claude or ChatGPT credential/);
  });
});
