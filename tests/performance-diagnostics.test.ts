import { afterEach, expect, test } from "vitest";
import { DiagnosticOperation, getPerformanceDiagnostics, resetPerformanceDiagnosticsForTests, diagnosticErrorType } from "../src/core/utils/performanceDiagnostics.js";
import { measureChatStream } from "../src/gateway/services/agent/chatPerformanceDiagnostics.js";
import type { StreamChunk, StreamChunkType } from "../src/core/types/streaming.js";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
afterEach(resetPerformanceDiagnosticsForTests);
const chunk = (type: StreamChunkType): StreamChunk => ({ type, payload: { text: "SECRET_MESSAGE", args: { token: "SECRET_TOKEN" } }, timestamp: new Date().toISOString() });

test("chat timing separates queue wait, first output and stream gaps without retaining payloads", async () => {
  async function* stream() {
    yield chunk("concurrency-queued");
    await sleep(20);
    expect(getPerformanceDiagnostics().active[0].status).toBe("queued");
    expect(getPerformanceDiagnostics().active[0].queueMs).toBeGreaterThan(0);
    yield chunk("concurrency-acquired");
    yield chunk("reasoning-delta");
    await sleep(20); yield chunk("text-delta");
    yield chunk("done");
  }
  const received: StreamChunk[] = [];
  for await (const c of measureChatStream(stream(), { chatId: "chat-1" })) received.push(c);
  expect(received).toHaveLength(5);
  const result = getPerformanceDiagnostics(); const record = result.recent[0];
  expect(result.active).toEqual([]);
  expect(record.status).toBe("completed");
  expect(record.queueMs).toBeGreaterThanOrEqual(10);
  expect(record.firstTextMs!).toBeGreaterThan(record.firstResponseMs!);
  expect(record.longestStreamGapMs).toBeGreaterThanOrEqual(10);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});
test("consumer cancellation closes the underlying generator and records cancellation", async () => {
  let closed = false;
  async function* stream() { try { yield chunk("text-delta"); yield chunk("done"); } finally { closed = true; } }
  for await (const _ of measureChatStream(stream(), { chatId: "cancel" })) break;
  expect(closed).toBe(true);
  expect(getPerformanceDiagnostics().recent[0].status).toBe("cancelled");
  expect(getPerformanceDiagnostics().active).toEqual([]);
});
test("failures propagate with a sanitized error category", async () => {
  const error = Object.assign(new Error("SECRET_URL"), { statusCode: 429 });
  async function* stream(): AsyncGenerator<StreamChunk> { throw error; }
  await expect(measureChatStream(stream(), {}).next()).rejects.toBe(error);
  expect(getPerformanceDiagnostics().recent[0].errorType).toBe("http_429");
  expect(JSON.stringify(getPerformanceDiagnostics())).not.toContain("SECRET_URL");
  expect(diagnosticErrorType({ name: "SECRET", code: "SECRET" })).toBe("error");
});
test("records are bounded per category, idempotent and snapshots cannot mutate retained data", () => {
  for (let i = 0; i < 300; i++) {
    const trace = new DiagnosticOperation("tool", "test"); trace.finish(); trace.finish();
  }
  const result = getPerformanceDiagnostics();
  expect(result.recent).toHaveLength(128);
  result.recent[0].name = "changed";
  expect(getPerformanceDiagnostics().recent[0].name).toBe("test");
  for (let i = 0; i < 300; i++) new DiagnosticOperation("background", "test", {}, true);
  expect(getPerformanceDiagnostics().active).toHaveLength(256);
  expect(getPerformanceDiagnostics().retention.evictedActive).toBe(44);
});

test("parallel chats attribute child operations to their own turn", async () => {
  async function* stream(name: string) {
    await sleep(name === "a" ? 10 : 2);
    const tool = new DiagnosticOperation("tool", `tool-${name}`);
    await sleep(3); tool.finish(); yield chunk("done");
  }
  await Promise.all(["a", "b"].map(async chatId => {
    for await (const _ of measureChatStream(stream(chatId), { chatId })) { /* drain */ }
  }));
  const records = getPerformanceDiagnostics().recent;
  for (const chatId of ["a", "b"]) {
    const chat = records.find(r => r.kind === "chat" && r.chatId === chatId)!;
    const tool = records.find(r => r.kind === "tool" && r.name === `tool-${chatId}`)!;
    expect(tool.chatId).toBe(chatId); expect(tool.turnId).toBe(chat.id);
  }
});
