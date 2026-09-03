/**
 * Contract tests for the Anthropic request body the AI SDK builds for us.
 *
 * These exist because the failure they cover is invisible: `ai` v6 renamed
 * `maxTokens` to `maxOutputTokens`, and passing the old name is not an error.
 * It is dropped as an unknown key with no warning, and @ai-sdk/anthropic then
 * substitutes its own 4096 default — so a model configured for 128K output was
 * silently capped at 4096 on every request. Nothing in types, lint, or runtime
 * logs catches that; only the wire format shows it.
 *
 * We assert against a local echo server rather than mocking the SDK, so the
 * tests fail if a future SDK version renames or reinterprets these options.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText, tool } from "ai";
import type { ModelMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { anthropicModelUsesAdaptiveThinking } from "../src/gateway/utils/anthropicAdaptiveThinking.js";

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  thinking?: { type: string; display?: string };
  messages: Array<{ role: string; content: unknown }>;
}

let server: http.Server;
let baseURL: string;
const received: AnthropicRequestBody[] = [];

/** Smallest SSE body that lets streamText resolve instead of throwing. */
function writeMinimalStream(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-fable-5-1",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })}\n\n`,
  );
  res.write(
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    })}\n\n`,
  );
  res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
  res.end();
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(JSON.parse(body) as AnthropicRequestBody);
      writeMinimalStream(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

/** Issue one request through the real SDK and return the body Anthropic would see. */
async function capture(
  extra: Record<string, unknown>,
  messages?: ModelMessage[],
): Promise<AnthropicRequestBody> {
  const anthropic = createAnthropic({
    apiKey: "test-key-not-real",
    baseURL,
  });
  const result = streamText({
    model: anthropic("claude-fable-5-1"),
    messages: messages ?? [{ role: "user", content: "hello" }],
    tools: {
      bash: tool({
        description: "Run a shell command",
        inputSchema: z.object({ command: z.string() }),
      }),
    },
    ...extra,
  });
  // Draining is what actually issues the request.
  for await (const _chunk of result.fullStream) {
    void _chunk;
  }
  const body = received.at(-1);
  if (!body) {
    throw new Error("echo server captured no request");
  }
  return body;
}

describe("anthropic request shape", () => {
  it("sends the configured output cap when using the v6 option name", async () => {
    const body = await capture({ maxOutputTokens: 128000 });
    expect(body.max_tokens).toBe(128000);
  });

  it("regression: the pre-v6 maxTokens name is silently ignored", async () => {
    // This is the bug, pinned. `maxTokens` does not throw and does not warn — it
    // is dropped, and the provider default takes over. If a future SDK starts
    // honouring or rejecting it, this test tells us the workaround can change.
    const body = await capture({ maxTokens: 128000 });
    expect(body.max_tokens).toBe(4096);
    expect(body.max_tokens).not.toBe(128000);
  });

  it("requests summarized adaptive thinking so reasoning text is not withheld", async () => {
    // Fable 5.1 enables thinking by itself once tools are present and streams
    // empty thinking deltas unless display is summarized, which renders as a
    // turn that produces nothing at all.
    const body = await capture({
      maxOutputTokens: 128000,
      providerOptions: {
        anthropic: {
          thinking: { type: "adaptive", display: "summarized" },
        },
      },
    });
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("never puts an unsigned thinking block on the wire", async () => {
    // Anthropic rejects a thinking block whose signature is missing or does not
    // match ("thinking.signature: Field required" / "Invalid `signature`"). Our
    // stored history carries reasoning text but no signature, so this is the
    // invariant that keeps a replayed turn from 400ing. The SDK drops such a
    // part and emits an "unsupported reasoning metadata" warning instead, which
    // is why we leave sendReasoning at its default rather than disabling it.
    const messages: ModelMessage[] = [
      { role: "user", content: "check the repo" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Prior reasoning with no signature." },
          { type: "text", text: "Let me look." },
        ],
      },
      { role: "user", content: "continue" },
    ];

    const body = await capture({ maxOutputTokens: 1000 }, messages);
    const sentBlockTypes = body.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c): c is { type: string } => typeof c === "object" && c !== null)
      .map((c) => c.type);

    expect(sentBlockTypes).not.toContain("thinking");
    // The text alongside the dropped reasoning must still survive.
    expect(sentBlockTypes).toContain("text");
  });
});

describe("anthropicModelUsesAdaptiveThinking", () => {
  it("covers the models that self-enable thinking", () => {
    // Verified against the live API: these return a thinking block with empty
    // text when tools are present.
    expect(anthropicModelUsesAdaptiveThinking("claude-fable-5-1")).toBe(true);
    expect(anthropicModelUsesAdaptiveThinking("claude-fable-5")).toBe(true);
    expect(anthropicModelUsesAdaptiveThinking("claude-sonnet-5")).toBe(true);
  });

  it("stays in step with the pi-ai override list", () => {
    expect(anthropicModelUsesAdaptiveThinking("claude-opus-5")).toBe(true);
    expect(anthropicModelUsesAdaptiveThinking("claude-opus-4-8")).toBe(true);
    expect(anthropicModelUsesAdaptiveThinking("claude-opus-4.8")).toBe(true);
  });

  it("leaves budget-thinking and non-Claude models alone", () => {
    expect(anthropicModelUsesAdaptiveThinking("claude-opus-4-7")).toBe(false);
    expect(anthropicModelUsesAdaptiveThinking("claude-opus-4-6")).toBe(false);
    expect(anthropicModelUsesAdaptiveThinking("claude-sonnet-4-6")).toBe(false);
    expect(anthropicModelUsesAdaptiveThinking("claude-haiku-4-5")).toBe(false);
    expect(anthropicModelUsesAdaptiveThinking("gpt-5-6-sol")).toBe(false);
  });
});
