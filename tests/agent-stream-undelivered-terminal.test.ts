/**
 * Issue: a finished turn that reached nobody, and left no trace of it.
 *
 * `sendJson` is a silent no-op on a socket that is not open, and
 * `removeSubscriber` deleted a socket without a word. So a completion could
 * reach zero listeners and the only evidence was the persisted row — the
 * original had to be diagnosed by querying chats.db by hand.
 *
 * Covered here: the terminal state is logged when it lands nowhere, and falls
 * back to a workspace broadcast keyed by chatId so a live client can still
 * render it.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import type { WebSocket } from "ws";

const broadcast = vi.fn();
vi.mock("../src/gateway/websocket/index.js", () => ({
  broadcast: (...args: unknown[]) => broadcast(...args),
}));

import { AgentStreamRegistry } from "../src/gateway/services/AgentStreamRegistry.js";

const OPEN = 1;
const CLOSED = 3;

function fakeSocket(readyState: number) {
  return {
    OPEN,
    readyState,
    send: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

/**
 * Inject a running stream directly. `startStream` would spin up the real agent
 * (it dynamically imports AgentService and streams), and the behaviour under
 * test is purely about delivery of the terminal state.
 */
function injectRunningStream(
  registry: AgentStreamRegistry,
  chatId: string,
  requestId: string,
  sockets: Array<WebSocket>,
) {
  const internals = registry as unknown as {
    streamsByRequestId: Map<string, Record<string, unknown>>;
    requestIdByChatId: Map<string, string>;
  };
  const subscribers = new Map(
    sockets.map((ws) => [ws, { ws, responseId: requestId }]),
  );
  const entry = {
    chatId,
    requestId,
    chunks: [],
    firstChunkIndex: 0,
    bufferedBytes: 0,
    subscribers,
    status: "running",
  };
  internals.streamsByRequestId.set(requestId, entry);
  internals.requestIdByChatId.set(chatId, requestId);
  return entry;
}

/**
 * Let the dynamic `import("../websocket/index.js")` settle. Module resolution
 * takes more than a microtask turn, so a macrotask is required — a few
 * `await Promise.resolve()` looks sufficient and silently reports no broadcast.
 */
async function flushBroadcast() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("undelivered terminal stream state", () => {
  let registry: AgentStreamRegistry;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    broadcast.mockClear();
    registry = new AgentStreamRegistry();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("delivers to an open subscriber and does not broadcast", async () => {
    const ws = fakeSocket(OPEN);
    injectRunningStream(registry, "chat-1", "req-1", [ws]);

    registry.cancelStream("chat-1", "Provider exploded");
    await flushBroadcast();

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sent.type).toBe("agent:error");
    expect(sent.id).toBe("req-1");
    // The direct send worked, so no fallback — otherwise a client with the
    // chat open in a second window would render the same error twice.
    expect(broadcast).not.toHaveBeenCalled();
  });

  /**
   * The case that produced the reported symptom: the subscriber list is not
   * empty, but the socket is no longer open. `sendJson` returns without
   * sending, so counting subscribers would have said "delivered".
   */
  it("falls back to broadcast when the only subscriber is closed", async () => {
    const ws = fakeSocket(CLOSED);
    injectRunningStream(registry, "chat-1", "req-1", [ws]);

    registry.cancelStream("chat-1", "Provider exploded");
    await flushBroadcast();

    expect(ws.send).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: "agent:error",
      data: { chatId: "chat-1", error: "Provider exploded" },
    });
  });

  it("falls back to broadcast when there are no subscribers at all", async () => {
    injectRunningStream(registry, "chat-1", "req-1", []);

    registry.cancelStream("chat-1", "Provider exploded");
    await flushBroadcast();

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: "agent:error",
      data: { chatId: "chat-1", error: "Provider exploded" },
    });
  });

  it("broadcasts if any subscriber is open, even when others are closed", async () => {
    const dead = fakeSocket(CLOSED);
    const live = fakeSocket(OPEN);
    injectRunningStream(registry, "chat-1", "req-1", [dead, live]);

    registry.cancelStream("chat-1", "Provider exploded");
    await flushBroadcast();

    expect(live.send).toHaveBeenCalledTimes(1);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("names the chat and the stream when nothing could be delivered", async () => {
    injectRunningStream(registry, "chat-xyz", "req-abc", []);

    registry.cancelStream("chat-xyz", "Provider exploded");
    await flushBroadcast();

    const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).toContain("chat-xyz");
    expect(message).toContain("req-abc");
    expect(message).toContain("no open subscriber");
  });

  /**
   * A user stop is silent by design — broadcasting it would show an error for
   * something the user did deliberately, and the client filters expected
   * cancellations anyway.
   */
  it("does not broadcast an expected cancellation", async () => {
    injectRunningStream(registry, "chat-1", "req-1", []);

    registry.cancelStream("chat-1", "Stopped by user");
    await flushBroadcast();

    expect(broadcast).not.toHaveBeenCalled();
  });

  it("logs when a running stream loses its last subscriber", () => {
    const ws = fakeSocket(OPEN);
    injectRunningStream(registry, "chat-1", "req-1", [ws]);

    registry.removeSubscriber(ws);

    const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).toContain("lost its last subscriber");
    expect(message).toContain("chat-1");
  });

  it("says nothing when a stream still has another subscriber", () => {
    const a = fakeSocket(OPEN);
    const b = fakeSocket(OPEN);
    injectRunningStream(registry, "chat-1", "req-1", [a, b]);

    registry.removeSubscriber(a);

    const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).not.toContain("lost its last subscriber");
  });

  it("says nothing when removing a socket it never tracked", () => {
    const tracked = fakeSocket(OPEN);
    const stranger = fakeSocket(OPEN);
    injectRunningStream(registry, "chat-1", "req-1", [tracked]);

    registry.removeSubscriber(stranger);

    const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).not.toContain("lost its last subscriber");
  });
});
