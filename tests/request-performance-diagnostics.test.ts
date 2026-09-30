import { afterEach, expect, test, vi } from "vitest";
import type { LanguageModel } from "ai";
import type { AnyTool } from "../src/core/agents/ToolRegistry.js";
import { getPerformanceDiagnostics, resetPerformanceDiagnosticsForTests } from "../src/core/utils/performanceDiagnostics.js";
import { measureLanguageModel, measureTools } from "../src/gateway/services/agent/requestPerformanceDiagnostics.js";
afterEach(resetPerformanceDiagnosticsForTests);

test("model wrapper preserves provider metadata and streamed chunks", async () => {
  const chunks = [{ type: "text-delta", delta: "SECRET" }, { type: "finish", finishReason: "stop" }];
  const source = { specificationVersion: "v3", provider: "test", modelId: "test", doStream: async () => ({ stream: new ReadableStream({ start(c) { chunks.forEach(x => c.enqueue(x)); c.close(); } }), response: { headers: { secret: "SECRET" } } }) };
  const model = measureLanguageModel(source as unknown as LanguageModel, { chatId: "chat", provider: "test" }) as typeof source;
  expect(model.specificationVersion).toBe("v3");
  const result = await model.doStream(); expect(result.response.headers.secret).toBe("SECRET");
  const reader = result.stream.getReader(); const received = [];
  while (true) { const item = await reader.read(); if (item.done) break; received.push(item.value); }
  expect(received).toEqual(chunks);
  const record = getPerformanceDiagnostics().recent[0];
  expect(record.kind).toBe("model"); expect(record.status).toBe("completed");
  expect(record.firstResponseMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(getPerformanceDiagnostics())).not.toContain("SECRET");
});
test("provider cancellation propagates to the original stream", async () => {
  const cancel = vi.fn();
  const source = { specificationVersion: "v2", doStream: async () => ({ stream: new ReadableStream({ cancel }) }) };
  const model = measureLanguageModel(source as unknown as LanguageModel, {}) as typeof source;
  await (await model.doStream()).stream.cancel("stop");
  expect(cancel).toHaveBeenCalledWith("stop");
  expect(getPerformanceDiagnostics().recent[0].status).toBe("cancelled");
});
test("provider setup and stream errors remain observable by the caller", async () => {
  const error = Object.assign(new Error("SECRET"), { statusCode: 503 });
  const source = { doStream: async () => { throw error; } };
  const model = measureLanguageModel(source as unknown as LanguageModel, {}) as typeof source;
  await expect(model.doStream()).rejects.toBe(error);
  expect(getPerformanceDiagnostics().recent[0].errorType).toBe("http_503");
  const streaming = { doStream: async () => ({ stream: new ReadableStream({ pull(c) { c.error(error); } }) }) };
  const wrapped = measureLanguageModel(streaming as unknown as LanguageModel, {}) as typeof streaming;
  await expect((await wrapped.doStream()).stream.getReader().read()).rejects.toBe(error);
  expect(getPerformanceDiagnostics().active).toEqual([]);
  expect(getPerformanceDiagnostics().recent).toHaveLength(2);
});
test("tool instrumentation preserves arguments/results and records errors without inputs", async () => {
  const error = new Error("SECRET");
  const execute = vi.fn(async (arg: unknown) => ({ success: true, result: arg }));
  const tools = measureTools({ ok: { execute } as unknown as AnyTool,
    bad: { execute: async () => { throw error; } } as unknown as AnyTool,
    failed: { execute: async () => ({ success: false, error: "SECRET" }) } as unknown as AnyTool,
  }, { chatId: "chat" });
  expect(await tools.ok.execute!({ token: "SECRET" }, {} as never)).toEqual({ success: true, result: { token: "SECRET" } });
  await expect(tools.bad.execute!({}, {} as never)).rejects.toBe(error);
  await tools.failed.execute!({}, {} as never);
  expect(getPerformanceDiagnostics().recent.map(x => x.status)).toEqual(["completed", "error", "error"]);
  expect(JSON.stringify(getPerformanceDiagnostics())).not.toContain("SECRET");
});

test("instrumented model works through the actual AI SDK stream pipeline", async () => {
  const { streamText } = await import("ai");
  const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
  const model = new MockLanguageModelV3({ doStream: {
    stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "hello" },
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      } },
    ] }),
  } });
  const result = streamText({ model: measureLanguageModel(model, { chatId: "sdk" }), prompt: "SECRET", maxRetries: 0 });
  expect(await result.text).toBe("hello");
  expect(getPerformanceDiagnostics().recent[0].status).toBe("completed");
  expect(model.doStreamCalls).toHaveLength(1);
});
