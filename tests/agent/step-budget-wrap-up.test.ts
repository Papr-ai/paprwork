/**
 * #675: an agent job with a small step budget (maxTurns 4) spent every step on
 * tool calls and ended with no reply, so the job failed with "produced no
 * output". The pi-ai loop now spends one extra text-only step to answer.
 */
import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import { createPiCodexStreamWithToolLoop } from "../../src/gateway/services/providers/PiCodexStreamWithToolLoop.js";
import { WRAP_UP_AFTER_TOOLS_NO_TEXT } from "../../src/gateway/services/agent/wrapUpContinuation.js";

const MODEL = { id: "gpt-5.6-luna", provider: "openai-codex", input: ["text"] };

type Ctx = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };

async function* events(list: unknown[]): AsyncGenerator<AssistantMessageEvent> {
  for (const e of list) yield e as AssistantMessageEvent;
}

function toolStep(n: number): unknown[] {
  const toolCall = { type: "toolCall", id: `call_${n}`, name: "list_directory", arguments: { path: "." } };
  return [
    { type: "toolcall_end", toolCall },
    { type: "done", reason: "toolUse", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-luna", content: [toolCall], stopReason: "toolUse" } },
  ];
}

const TEXT = [
  { type: "text_delta", delta: "OK" },
  { type: "done", reason: "stop", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-luna", content: [{ type: "text", text: "OK" }], stopReason: "stop" } },
];

async function run(maxSteps: number, answerWhenToolsRemoved: boolean) {
  const seen: Ctx[] = [];
  const streamSimple = (_m: unknown, context: unknown) => {
    const ctx = context as Ctx;
    seen.push({ messages: [...ctx.messages], tools: ctx.tools ? [...ctx.tools] : undefined });
    const toolsOff = !ctx.tools || ctx.tools.length === 0;
    return events(toolsOff && answerWhenToolsRemoved ? TEXT : toolStep(seen.length));
  };
  let text = "";
  const chunks: string[] = [];
  for await (const chunk of createPiCodexStreamWithToolLoop(
    streamSimple,
    MODEL,
    { messages: [{ role: "user", content: "Reply with exactly the word OK." }], tools: [{ name: "list_directory" }] },
    { apiKey: "test", sessionId: "s-675" },
    { list_directory: { execute: async () => ({ entries: ["a"] }) } },
    [],
    maxSteps,
    undefined,
    { chatId: "job:675" },
  )) {
    chunks.push(chunk.type);
    if (chunk.type === "text-delta") text += (chunk as { text: string }).text;
  }
  return { seen, text, chunks };
}

describe("step budget spent on tool calls (#675)", () => {
  it("adds one text-only step so the turn ends with a reply", async () => {
    const { seen, text } = await run(4, true);
    expect(text).toBe("OK");
    expect(seen).toHaveLength(5);
    const last = seen[seen.length - 1]!;
    expect(last.tools).toEqual([]);
    expect(last.messages[last.messages.length - 1]!.content).toBe(WRAP_UP_AFTER_TOOLS_NO_TEXT);
    // Every step inside the budget kept its tools.
    expect(seen.slice(0, 4).every((c) => (c.tools ?? []).length === 1)).toBe(true);
  });

  it("spends at most one extra step, even if the model still answers with tools", async () => {
    const { seen, text } = await run(2, false);
    expect(seen).toHaveLength(3);
    expect(text).toBe("");
  });

  it("leaves a turn that answered inside its budget alone", async () => {
    const seen: Ctx[] = [];
    const streamSimple = (_m: unknown, context: unknown) => {
      seen.push(context as Ctx);
      return events(seen.length === 1 ? toolStep(1) : TEXT);
    };
    let text = "";
    for await (const chunk of createPiCodexStreamWithToolLoop(
      streamSimple, MODEL, { messages: [{ role: "user", content: "hi" }], tools: [{ name: "list_directory" }] },
      { apiKey: "test", sessionId: "s" }, { list_directory: { execute: async () => "x" } }, [], 4,
    )) if (chunk.type === "text-delta") text += (chunk as { text: string }).text;
    expect(text).toBe("OK");
    expect(seen).toHaveLength(2);
  });
});
