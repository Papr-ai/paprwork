import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AgentStreamConcurrencyGate,
  AgentStreamConcurrencyTimeoutError,
  AGENT_STREAM_ACQUIRE_TIMEOUT_MS,
  BACKGROUND_AGENT_STREAM_ACQUIRE_TIMEOUT_MS,
  DEFAULT_AGENT_STREAM_MAX_CONCURRENT,
  resetAgentStreamConcurrencyGateForTests,
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
