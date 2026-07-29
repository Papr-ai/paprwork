import { describe, expect, test, beforeEach, vi } from "vitest";
import {
  AgentStreamConcurrencyGate,
  AgentStreamConcurrencyTimeoutError,
  AGENT_STREAM_ACQUIRE_TIMEOUT_MS,
  resetAgentStreamConcurrencyGateForTests,
} from "../src/gateway/services/agent/agentStreamConcurrency.js";

describe("AgentStreamConcurrencyGate", () => {
  beforeEach(() => {
    resetAgentStreamConcurrencyGateForTests();
    delete process.env.AGENT_STREAM_MAX_CONCURRENT;
  });

  test("allows up to max concurrent streams", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "2";
    const gate = new AgentStreamConcurrencyGate();

    await gate.acquire("chat-a");
    await gate.acquire("chat-b");

    expect(gate.getStats().activeCount).toBe(2);

    gate.release("chat-a");
    expect(gate.getStats().activeCount).toBe(1);
  });

  test("queues third stream until a slot frees", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "2";
    const gate = new AgentStreamConcurrencyGate();

    await gate.acquire("chat-a");
    await gate.acquire("chat-b");

    let admitted = false;
    const pending = gate.acquire("chat-c").then(() => {
      admitted = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(admitted).toBe(false);

    gate.release("chat-a");
    await pending;
    expect(admitted).toBe(true);
    expect(gate.getStats().activeChatIds).toContain("chat-c");
  });

  test("rejects waiters after timeout", async () => {
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
    vi.useRealTimers();
  });

  test("does not double-acquire the same chatId", async () => {
    process.env.AGENT_STREAM_MAX_CONCURRENT = "1";
    const gate = new AgentStreamConcurrencyGate();

    await gate.acquire("chat-a");
    await gate.acquire("chat-a");

    expect(gate.getStats().activeCount).toBe(1);
  });
});
