/**
 * Job SDK papr_llm: credential routing + caching.
 *
 * Runs the real Python module against a local HTTP server standing in for the
 * Anthropic, OpenAI and ChatGPT endpoints, and checks the request shape each
 * credential kind needs.
 */
import { spawn } from "child_process";
import http from "http";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SDK = path.resolve(__dirname, "../../src/resources/job-sdk");

type Seen = { url: string; headers: http.IncomingHttpHeaders; body: any };
let server: http.Server;
let base = "";
let seen: Seen[] = [];

function chatgptToken(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })}.sig`;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/anthropic") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          content: [{ type: "text", text: "claude says hi" }],
          usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
        }));
      } else if (req.url === "/openai") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          output_text: "{\"ok\": true}",
          usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 12 } },
        }));
      } else if (req.url === "/chatgpt") {
        res.setHeader("content-type", "text/event-stream");
        const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
        res.end(
          ev({ type: "response.output_text.delta", delta: "chat" }) +
          ev({ type: "response.output_text.delta", delta: "gpt" }) +
          ev({ type: "response.completed", response: { usage: { input_tokens: 30, output_tokens: 2, input_tokens_details: { cached_tokens: 25 } } } }) +
          "data: [DONE]\n\n",
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
});

function run(code: string, env: Record<string, string>) {
  // Async spawn: spawnSync would block the event loop and the server could not answer.
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn("python3", ["-c", code], {
      env: {
        PATH: process.env.PATH ?? "",
        PYTHONPATH: SDK,
        PAPR_LLM_ANTHROPIC_URL: `${base}/anthropic`,
        PAPR_LLM_OPENAI_URL: `${base}/openai`,
        PAPR_LLM_CHATGPT_URL: `${base}/chatgpt`,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("papr_llm", () => {
  it("Claude sign-in token: Bearer + Claude Code identity, cache_control on stable parts", async () => {
    const r = await run(
      "from papr_llm import complete\nr=complete('q', system='S', context='C', provider='anthropic')\nprint(r.text, r.usage['cache_read_input_tokens'])",
      { ANTHROPIC_API_KEY: "sk-ant-oat01-test" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("claude says hi 900");
    expect(r.stderr).toContain("cache_read=900");
    const req = seen[0];
    expect(req.headers.authorization).toBe("Bearer sk-ant-oat01-test");
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(String(req.headers["anthropic-beta"])).toContain("oauth-2025-04-20");
    expect(req.body.system[0].text).toContain("Claude Code");
    expect(req.body.system.at(-1)).toMatchObject({ text: "S", cache_control: { type: "ephemeral" } });
    expect(req.body.messages[0].content[0]).toMatchObject({ text: "C", cache_control: { type: "ephemeral" } });
    expect(req.body.messages[0].content[1]).toEqual({ type: "text", text: "q" });
  });

  it("Claude API key: x-api-key, no Claude Code line, 1h TTL when asked", async () => {
    const r = await run(
      "from papr_llm import complete\ncomplete('q', system='S', provider='anthropic', cache_ttl='1h')",
      { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
    );
    expect(r.status, r.stderr).toBe(0);
    const req = seen[0];
    expect(req.headers["x-api-key"]).toBe("sk-ant-api03-test");
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body.system).toEqual([{ type: "text", text: "S", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  });

  it("cache=False sends no cache_control", async () => {
    await run("from papr_llm import complete\ncomplete('q', system='S', context='C', provider='anthropic', cache=False)", {
      ANTHROPIC_API_KEY: "sk-ant-api03-test",
    });
    expect(JSON.stringify(seen[0].body)).not.toContain("cache_control");
  });

  it("OpenAI API key: Responses API with prompt_cache_key; complete_json parses", async () => {
    const r = await run(
      "from papr_llm import complete_json\nprint(complete_json('q', provider='openai', model='gpt-5-6-sol'))",
      { OPENAI_API_KEY: "sk-proj-test" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("{'ok': True}");
    const req = seen[0];
    expect(req.url).toBe("/openai");
    expect(req.body.model).toBe("gpt-5.6-sol");
    expect(req.body.prompt_cache_key).toMatch(/^papr-llm-/);
  });

  it("ChatGPT sign-in token: Codex endpoint, account header, streamed text, web search", async () => {
    const r = await run(
      "from papr_llm import complete\nr=complete('q', system='S', provider='openai', web_search=True)\nprint(r.model, r.text, r.usage['cache_read_input_tokens'])",
      { OPENAI_API_KEY: chatgptToken() },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("gpt-5.6-sol chatgpt 25");
    const req = seen[0];
    expect(req.url).toBe("/chatgpt");
    expect(req.headers["chatgpt-account-id"]).toBe("acct-1");
    expect(req.headers["session_id"]).toBe(req.body.prompt_cache_key);
    expect(req.body).toMatchObject({ stream: true, store: false, instructions: "S", tools: [{ type: "web_search" }] });
  });

  it("no credential: clear error naming the key", async () => {
    const r = await run("from papr_llm import complete\ncomplete('q')", {});
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("No model credential");
  });
});
