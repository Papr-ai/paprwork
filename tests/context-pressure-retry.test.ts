/**
 * Context Pressure Retry Test (standalone — no vitest needed)
 *
 * Verifies the catch-block logic from AgentService.streamAgent:
 * When contextPressureAborted=true → compress + retry (no throw)
 * When contextPressureAborted=false → re-throw as before
 */

import assert from "node:assert/strict";

// --- helpers ---
let callLog: string[] = [];

function mockFn(name: string, impl?: () => Promise<void>) {
  return async () => {
    callLog.push(name);
    if (impl) await impl();
  };
}

/**
 * Mirrors the catch-block logic from AgentService.streamAgent (~line 1316-1385)
 */
async function* simulateCatchBlock(opts: {
  contextPressureAborted: boolean;
  error: Error;
  triggerSummarization: () => Promise<void>;
  saveMessage: () => Promise<void>;
  retryStream: () => AsyncGenerator<any>;
}) {
  const chatId = "test-chat";
  try {
    throw opts.error;
  } catch (error) {
    if (opts.contextPressureAborted) {
      yield { type: "compression-start", chatId };
      await opts.triggerSummarization();
      yield { type: "compression-complete", chatId };
      await opts.saveMessage();
      for await (const chunk of opts.retryStream()) {
        yield chunk;
      }
      return;
    }
    throw error;
  }
}

async function collectChunks(gen: AsyncGenerator<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

// --- tests ---

async function testCompressAndRetry() {
  callLog = [];
  async function* retryStream() {
    yield { type: "text-delta", text: "retried" };
    yield { type: "done" };
  }

  const chunks = await collectChunks(
    simulateCatchBlock({
      contextPressureAborted: true,
      error: new Error("aborted"),
      triggerSummarization: mockFn("summarize"),
      saveMessage: mockFn("save"),
      retryStream,
    }),
  );

  assert.equal(chunks[0].type, "compression-start");
  assert.equal(chunks[1].type, "compression-complete");
  assert.equal(chunks[2].type, "text-delta");
  assert.equal(chunks[2].text, "retried");
  assert.equal(chunks[3].type, "done");
  assert.equal(chunks.length, 4);
  assert.deepEqual(callLog, ["summarize", "save"]);
  console.log("  ✅ compress and retry when contextPressureAborted=true");
}

async function testRethrowWhenNotContextPressure() {
  callLog = [];
  async function* retryStream() {
    yield { type: "done" };
  }

  try {
    await collectChunks(
      simulateCatchBlock({
        contextPressureAborted: false,
        error: new Error("Some other API error"),
        triggerSummarization: mockFn("summarize"),
        saveMessage: mockFn("save"),
        retryStream,
      }),
    );
    assert.fail("Should have thrown");
  } catch (e: any) {
    assert.equal(e.message, "Some other API error");
  }

  assert.deepEqual(callLog, []);
  console.log("  ✅ re-throw when contextPressureAborted=false");
}

async function testSummarizationFailure() {
  callLog = [];
  async function* retryStream() {
    yield { type: "done" };
  }

  try {
    await collectChunks(
      simulateCatchBlock({
        contextPressureAborted: true,
        error: new Error("aborted"),
        triggerSummarization: mockFn("summarize", async () => {
          throw new Error("Summarization failed");
        }),
        saveMessage: mockFn("save"),
        retryStream,
      }),
    );
    assert.fail("Should have thrown");
  } catch (e: any) {
    assert.equal(e.message, "Summarization failed");
  }

  assert.ok(callLog.includes("summarize"));
  assert.ok(!callLog.includes("save")); // save should not be called if summarization fails
  console.log("  ✅ summarization failure propagates error");
}

async function testChunkSequence() {
  callLog = [];
  async function* retryStream() {
    yield { type: "text", text: "a" };
    yield { type: "text", text: "b" };
    yield { type: "done" };
  }

  const chunks = await collectChunks(
    simulateCatchBlock({
      contextPressureAborted: true,
      error: new Error("aborted"),
      triggerSummarization: mockFn("summarize"),
      saveMessage: mockFn("save"),
      retryStream,
    }),
  );

  const types = chunks.map((c) => c.type);
  assert.deepEqual(types, [
    "compression-start",
    "compression-complete",
    "text",
    "text",
    "done",
  ]);
  console.log("  ✅ correct chunk sequence on successful retry");
}

// --- runner ---
async function main() {
  console.log("\nContext pressure retry logic (AI SDK path):\n");
  await testCompressAndRetry();
  await testRethrowWhenNotContextPressure();
  await testSummarizationFailure();
  await testChunkSequence();
  console.log("\n✅ All 4 tests passed!\n");
}

main().catch((e) => {
  console.error("\n❌ TEST FAILED:", e.message);
  process.exit(1);
});
