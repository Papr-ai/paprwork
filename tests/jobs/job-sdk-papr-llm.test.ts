/**
 * Job SDK papr_llm: thin client for POST /api/llm/complete.
 *
 * Runs the real Python module against a local HTTP server standing in for the
 * Papr gateway: checks the request it sends, how it maps the reply, its retry
 * on transient gateway errors, and complete_json parsing.
 */
import { spawn } from "child_process";
import http from "http";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SDK = path.resolve(__dirname, "../../src/resources/job-sdk");

type Seen = { url: string; body: any };
let server: http.Server;
let base = "";
let seen: Seen[] = [];
let replies: Array<{ status: number; body: unknown }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : {} });
      const next = replies.shift() ?? {
        status: 200,
        body: {
          text: "hello",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          route: "sign-in",
          usage: { inputTokens: 17, outputTokens: 3, cacheReadTokens: 3225, cacheWriteTokens: 0 },
          costUsd: 0.0012,
          retries: [],
        },
      };
      res.statusCode = next.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
  replies = [];
});

function run(code: string) {
  // Async spawn: spawnSync would block the event loop and the server could not answer.
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn("python3", ["-c", code], {
      env: { PATH: process.env.PATH ?? "", PYTHONPATH: SDK, PAPR_GATEWAY_URL: base },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("papr_llm (gateway client)", () => {
  it("posts one request to /api/llm/complete and maps the reply", async () => {
    const r = await run(
      "from papr_llm import complete\n" +
        "r = complete('Q', system='S', context='C', provider='anthropic', web_search=True, cache_ttl='1h')\n" +
        "print(r.text, r.provider, r.model, r.route, r.usage['cache_read_input_tokens'], r.cost_usd)",
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("hello anthropic claude-sonnet-4-6 sign-in 3225 0.0012");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/llm/complete");
    expect(seen[0].body).toMatchObject({
      prompt: "Q",
      system: "S",
      context: "C",
      provider: "anthropic",
      webSearch: true,
      cache: true,
      cacheTtl: "1h",
      maxTokens: 4096,
    });
    expect(seen[0].body).not.toHaveProperty("model");
    expect(r.stderr).toContain("[papr_llm] anthropic/claude-sonnet-4-6 (sign-in)");
    expect(r.stderr).toContain("cache_read=3225");
  });

  it("needs no API key in the job environment", async () => {
    const r = await run("from papr_llm import complete\nprint(complete('Q').text)");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("retries transient gateway errors, not client errors", async () => {
    replies = [{ status: 503, body: { error: "busy" } }];
    const ok = await run("from papr_llm import complete\nprint(complete('Q').text)");
    expect(ok.status).toBe(0);
    expect(seen).toHaveLength(2);

    seen = [];
    replies = [{ status: 401, body: { error: "Connect Claude or ChatGPT in Settings" } }];
    const bad = await run(
      "from papr_llm import complete, LLMError\n" +
        "try:\n  complete('Q')\nexcept LLMError as e:\n  print('ERR', e.status, e)",
    );
    expect(bad.stdout).toContain("ERR 401");
    expect(bad.stdout).toContain("Connect Claude or ChatGPT in Settings");
    expect(seen).toHaveLength(1);
  });

  it("rejects bad arguments before calling the gateway", async () => {
    const r = await run(
      "from papr_llm import complete, LLMError\n" +
        "for kw in ({'cache_ttl': '2h'}, {'provider': 'gemini'}):\n" +
        "  try:\n    complete('Q', **kw)\n  except LLMError as e:\n    print('ERR', e)",
    );
    expect(r.stdout.match(/ERR/g)).toHaveLength(2);
    expect(seen).toHaveLength(0);
  });

  it("complete_json parses fenced JSON and adds the JSON instruction", async () => {
    replies = [{ status: 200, body: { text: "```json\n{\"ok\": true}\n```", usage: {} } }];
    const r = await run(
      "from papr_llm import complete_json\nprint(complete_json('Q', system='Base'))",
    );
    expect(r.stdout.trim()).toBe("{'ok': True}");
    expect(seen[0].body.system).toBe("Base\n\nReply with JSON only: no prose, no code fences.");
  });
});
