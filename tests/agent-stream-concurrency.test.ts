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

  test("defaults to six concurrent agent streams", () => {
    const gate = new AgentStreamConcurrencyGate();
    expect(DEFAULT_AGENT_STREAM_MAX_CONCURRENT).toBe(6);
    expect(gate.getStats().maxConcurrent).toBe(6);
  });

  test("allows two foreground streams", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "2";
    const gate = new AgentStreamConcurrencyGate();
    const a = await gate.acquire("chat-a");
    const b = await gate.acquire("chat-b");
    expect(gate.getStats().activeCount).toBe(2);
    gate.release(a);
    gate.release(b);
    expect(gate.getStats().activeCount).toBe(0);
  });

  test("reserves one slot from background work for foreground chat", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "2";
    const gate = new AgentStreamConcurrencyGate();
    const job = await gate.acquire("job:a", undefined, "background");
    let secondJobAdmitted = false;
    const secondJob = gate.acquire("job:b", undefined, "background").then((lease) => {
      secondJobAdmitted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondJobAdmitted).toBe(false);

    const chat = await gate.acquire("chat-a", undefined, "foreground");
    expect(gate.getStats().activeCount).toBe(2);
    gate.release(chat);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondJobAdmitted).toBe(false);

    gate.release(job);
    const secondLease = await secondJob;
    expect(secondJobAdmitted).toBe(true);
    gate.release(secondLease);
  });

  test("foreground waits only briefly before returning a useful error", async () => {
    vi.useFakeTimers();
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    await gate.acquire("chat-a");
    const pending = gate.acquire("chat-b");
    const expectation = expect(pending).rejects.toBeInstanceOf(
      AgentStreamConcurrencyTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_ACQUIRE_TIMEOUT_MS + 1);
    await expectation;
  });

  test("background work retains the longer queue timeout", async () => {
    vi.useFakeTimers();
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    await gate.acquire("chat-a");
    const pending = gate.acquire("job:a", undefined, "background");
    let rejected = false;
    void pending.catch(() => { rejected = true; });
    await vi.advanceTimersByTimeAsync(AGENT_STREAM_ACQUIRE_TIMEOUT_MS + 1);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(
      BACKGROUND_AGENT_STREAM_ACQUIRE_TIMEOUT_MS - AGENT_STREAM_ACQUIRE_TIMEOUT_MS,
    );
    await expect(pending).rejects.toBeInstanceOf(AgentStreamConcurrencyTimeoutError);
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
    expect(gate.getStats().activeCount).toBe(1);
    gate.release(second);
    expect(gate.getStats().activeCount).toBe(0);
  });

  test("aborts a queued replacement", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    const first = await gate.acquire("chat-a");
    const controller = new AbortController();
    const replacement = gate.acquire("chat-a", controller.signal);
    controller.abort();
    await expect(replacement).rejects.toThrow("cancelled while waiting");
    expect(gate.getStats().waitingCount).toBe(0);
    gate.release(first);
  });

  test("forceReleaseByChatId immediately frees a slot for replacement", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    const first = await gate.acquire("chat-a");
    expect(gate.getStats().activeCount).toBe(1);

    // Force release (simulates stopStreaming being called)
    const released = gate.forceReleaseByChatId("chat-a");
    expect(released).toBe(true);
    expect(gate.getStats().activeCount).toBe(0);

    // New stream can now acquire immediately
    const second = await gate.acquire("chat-a");
    expect(gate.getStats().activeCount).toBe(1);

    // Original release is a no-op (token mismatch)
    gate.release(first);
    expect(gate.getStats().activeCount).toBe(1);
    gate.release(second);
    expect(gate.getStats().activeCount).toBe(0);
  });

  test("forceReleaseByChatId drains waiting queue", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();
    await gate.acquire("chat-a");

    // Queue a replacement
    let admitted = false;
    const replacement = gate.acquire("chat-a").then((lease) => {
      admitted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(admitted).toBe(false);

    // Force release should drain queue and admit the replacement
    gate.forceReleaseByChatId("chat-a");
    const second = await replacement;
    expect(admitted).toBe(true);
    gate.release(second);
  });
});
