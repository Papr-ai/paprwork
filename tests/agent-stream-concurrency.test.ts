import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AgentStreamConcurrencyGate,
  AgentStreamConcurrencyTimeoutError,
  AGENT_STREAM_ACQUIRE_TIMEOUT_MS,
  BACKGROUND_AGENT_STREAM_ACQUIRE_TIMEOUT_MS,
  DEFAULT_AGENT_STREAM_MAX_CONCURRENT,
  resetAgentStreamConcurrencyGateForTests,
  yieldOrReleaseLease,
} from "../src/gateway/services/agent/agentStreamConcurrency.js";

describe("AgentStreamConcurrencyGate", () => {
  beforeEach(() => {
    resetAgentStreamConcurrencyGateForTests();
    delete process.env.AGENT_STREAM_MAX_CONCURRENT;
  });
  afterEach(() => vi.useRealTimers());

  test("defaults to six concurrent streams per pool", () => {
    const gate = new AgentStreamConcurrencyGate();
    expect(DEFAULT_AGENT_STREAM_MAX_CONCURRENT).toBe(6);
    expect(gate.getStats().chat.maxConcurrent).toBe(6);
    expect(gate.getStats().job.maxConcurrent).toBe(6);
  });

  test("chat and job pools are independent", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    const job = await gate.acquire("job:a");
    const chat = await gate.acquire("chat-a");
    expect(gate.getStats().job.activeCount).toBe(1);
    expect(gate.getStats().chat.activeCount).toBe(1);
    gate.release(job);
    gate.release(chat);
  });

  test("six jobs do not block a seventh chat", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "2";
    const gate = new AgentStreamConcurrencyGate();
    const jobs = await Promise.all([
      gate.acquire("job:1"),
      gate.acquire("job:2"),
    ]);
    const chat = await gate.acquire("chat-a");
    expect(chat.pool).toBe("chat");
    expect(gate.getStats().job.activeCount).toBe(2);
    expect(gate.getStats().chat.activeCount).toBe(1);
    for (const lease of jobs) gate.release(lease);
    gate.release(chat);
  });

  test("chat pool blocks additional chats at capacity", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    await gate.acquire("chat-a");
    let secondAdmitted = false;
    const second = gate.acquire("chat-b").then((lease) => {
      secondAdmitted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAdmitted).toBe(false);
    gate.forceReleaseByChatId("chat-a");
    await second;
    expect(secondAdmitted).toBe(true);
  });

  test("chat pool waits indefinitely by default (no timeout)", async () => {
    vi.useFakeTimers();
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    await gate.acquire("chat-a");
    const pending = gate.acquire("chat-b");
    let rejected = false;
    void pending.catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_ACQUIRE_TIMEOUT_MS + 60_000);
    expect(rejected).toBe(false);
  });

  test("job pool retains the longer queue timeout", async () => {
    vi.useFakeTimers();
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    await gate.acquire("job:a");
    const pending = gate.acquire("job:b");
    let rejected = false;
    void pending.catch(() => {
      rejected = true;
    });
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_ACQUIRE_TIMEOUT_MS + 1);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(
      BACKGROUND_AGENT_STREAM_ACQUIRE_TIMEOUT_MS - AGENT_STREAM_ACQUIRE_TIMEOUT_MS,
    );
    await expect(pending).rejects.toBeInstanceOf(AgentStreamConcurrencyTimeoutError);
  });

  test("acquireWithEvents yields queued then admitted", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    await gate.acquire("chat-a");

    const events: string[] = [];
    let leasePromise: Promise<unknown> | undefined;
    const run = async () => {
      for await (const event of gate.acquireWithEvents("chat-b")) {
        events.push(event.type);
      }
    };
    leasePromise = run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["queued"]);

    gate.forceReleaseByChatId("chat-a");
    await leasePromise;
    expect(events).toEqual(["queued", "admitted"]);
  });

  test("serializes replacement streams and ignores stale releases", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    const first = await gate.acquire("chat-a");
    let admitted = false;
    const replacement = gate.acquire("chat-a").then((lease) => {
      admitted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(admitted).toBe(false);
    gate.release(first);
    const second = await replacement;
    gate.release(first);
    expect(gate.getStats().chat.activeCount).toBe(1);
    gate.release(second);
    expect(gate.getStats().chat.activeCount).toBe(0);
  });

  test("aborts a queued replacement", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    const first = await gate.acquire("chat-a");
    const controller = new AbortController();
    const replacement = gate.acquire("chat-a", controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(replacement).rejects.toThrow("cancelled while waiting");
    expect(gate.getStats().chat.waitingCount).toBe(0);
    gate.release(first);
  });

  test("forceReleaseByChatId immediately frees a slot for replacement", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    const first = await gate.acquire("chat-a");
    expect(gate.getStats().chat.activeCount).toBe(1);

    const released = gate.forceReleaseByChatId("chat-a");
    expect(released).toBe(true);
    expect(gate.getStats().chat.activeCount).toBe(0);

    const second = await gate.acquire("chat-a");
    expect(gate.getStats().chat.activeCount).toBe(1);

    gate.release(first);
    expect(gate.getStats().chat.activeCount).toBe(1);
    gate.release(second);
    expect(gate.getStats().chat.activeCount).toBe(0);
  });
});

describe("yieldOrReleaseLease", () => {
  test("releases when the consumer stops at the chunk", async () => {
    const release = vi.fn();
    async function* stream() {
      yield* yieldOrReleaseLease("acquired", release);
      yield "never reached";
    }
    for await (const chunk of stream()) {
      expect(chunk).toBe("acquired");
      break;
    }
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("leaves the lease alone once the consumer resumes", async () => {
    const release = vi.fn();
    async function* stream() {
      yield* yieldOrReleaseLease("acquired", release);
      yield "next";
    }
    const seen: string[] = [];
    for await (const chunk of stream()) seen.push(chunk);
    expect(seen).toEqual(["acquired", "next"]);
    expect(release).not.toHaveBeenCalled();
  });

  // A new chat's first message arrived twice ~500 ms apart. The replacement's stop
  // ran before the first stream registered its abort controller, so the first still
  // took a slot, and the registry then broke out of it at `concurrency-acquired`.
  // The lease was held outside the try whose finally releases it, so the second
  // stream queued behind its own chat forever with 1/6 slots in use.
  test("a stream abandoned at concurrency-acquired does not strand its chat", async () => {
    const gate = new AgentStreamConcurrencyGate();
    async function* firstStream() {
      let lease: Awaited<ReturnType<typeof gate.acquire>> | undefined;
      const release = () => {
        if (lease) gate.release(lease);
        lease = undefined;
      };
      for await (const event of gate.acquireWithEvents("chat-new")) {
        if (event.type !== "admitted") continue;
        lease = event.lease;
        yield* yieldOrReleaseLease("concurrency-acquired", release);
      }
      try {
        yield "model work";
      } finally {
        release();
      }
    }

    for await (const _chunk of firstStream()) break;

    const replacement = await gate.acquire("chat-new");
    expect(gate.getStats().chat.activeChatIds).toEqual(["chat-new"]);
    gate.release(replacement);
  });
});

describe("AgentService holds its lease only for the turn", () => {
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const source = fs
    .readFileSync(path.join(ROOT, "src/gateway/services/AgentService.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  function requireIndex(anchor: string, from = 0): number {
    const index = source.indexOf(anchor, from);
    if (index === -1) {
      throw new Error(
        `AgentService.ts no longer contains ${JSON.stringify(anchor)} — update the ` +
          "anchor, never delete the invariant.",
      );
    }
    return index;
  }

  test("releases before the final done chunk, not after export", () => {
    const done = requireIndex('type: "done",\n        chatId,\n        payload: { finalMessage: assistantMsg }');
    const release = source.lastIndexOf("releaseConcurrencyLease();", done);
    const exportCall = requireIndex("this.chatExporter.exportChat(", done);
    expect(release).toBeGreaterThan(requireIndex('recordTurnMetricsOnce("completed")'));
    expect(release).toBeLessThan(done);
    expect(exportCall).toBeGreaterThan(done);
  });

  test("guards both yields that happen before the main try", () => {
    const acquired = requireIndex('type: "concurrency-acquired"');
    const streamStart = requireIndex('type: "stream-start"');
    for (const at of [acquired, streamStart]) {
      const guard = source.lastIndexOf("yield* yieldOrReleaseLease(", at);
      expect(guard).toBeGreaterThan(-1);
      expect(source.slice(guard, at)).not.toContain(";");
    }
  });

  test("gate-skipping retries release the outer lease at their done", () => {
    for (const flag of ["_isContextCompressRetry: true,", "_isSilentRetry: true,"]) {
      const retry = requireIndex(flag);
      const loopBody = source.slice(retry, source.indexOf("yield chunk;", retry));
      expect(loopBody).toContain('if (chunk.type === "done") releaseConcurrencyLease();');
    }
  });
});
