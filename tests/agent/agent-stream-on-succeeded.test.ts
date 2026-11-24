/**
 * #739 follow-up: paprwork_user_message_sent (Active 7D/30D) must count a
 * message only when its reply succeeds. startStream's onSucceeded runs once
 * for a finished reply or a user stop, never for a failed or replaced one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

type Chunk = { type: string; payload?: unknown };
let script: (signal: { stopped: boolean }) => AsyncGenerator<Chunk>;
const signal = { stopped: false };

vi.mock("../../src/gateway/websocket/index.js", () => ({ broadcast: vi.fn() }));
vi.mock("../../src/gateway/services/AgentService.js", () => ({
  getAgentService: () => ({
    streamAgent: () => script(signal),
    getChatHistory: async () => [{ role: "assistant", content: "ok" }],
    stopStreaming: async () => {
      signal.stopped = true;
    },
  }),
}));

import { AgentStreamRegistry } from "../../src/gateway/services/AgentStreamRegistry.js";
import {
  STREAM_REPLACED_REASON,
  STREAM_STOPPED_BY_USER_REASON,
} from "../../src/core/constants/streamCancellation.js";

const ws = { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as WebSocket;
const tick = () => new Promise((r) => setTimeout(r, 0));

async function settle(registry: AgentStreamRegistry, chatId: string) {
  for (let i = 0; i < 50 && registry.isStreamRunning(chatId); i++) await tick();
  await tick();
}

function start(registry: AgentStreamRegistry, chatId: string, onSucceeded: () => void) {
  registry.startStream({
    chatId,
    requestId: `req-${chatId}-${Math.random()}`,
    userMessage: "hi",
    config: {} as never,
    ws,
    onSucceeded,
  });
}

describe("startStream onSucceeded", () => {
  let registry: AgentStreamRegistry;

  beforeEach(() => {
    registry = new AgentStreamRegistry();
    signal.stopped = false;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("fires once when the reply finishes", async () => {
    script = async function* () {
      yield { type: "text-delta", payload: { text: "hello" } };
    };
    const ok = vi.fn();
    start(registry, "c1", ok);
    await settle(registry, "c1");
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the model reports an error (e.g. invalid API key)", async () => {
    script = async function* () {
      yield { type: "error", payload: { error: "Invalid API key" } };
    };
    const ok = vi.fn();
    start(registry, "c2", ok);
    await settle(registry, "c2");
    expect(ok).not.toHaveBeenCalled();
  });

  it("does not fire when the stream throws", async () => {
    script = async function* () {
      yield* [];
      throw new Error("provider down");
    };
    const ok = vi.fn();
    start(registry, "c3", ok);
    await settle(registry, "c3");
    expect(ok).not.toHaveBeenCalled();
  });

  async function* waitForStop(s: { stopped: boolean }) {
    yield { type: "text-delta", payload: { text: "partial" } };
    while (!s.stopped) await tick();
  }

  it("fires when the user presses stop", async () => {
    script = waitForStop;
    const ok = vi.fn();
    start(registry, "c4", ok);
    await tick();
    signal.stopped = true;
    registry.cancelStream("c4", STREAM_STOPPED_BY_USER_REASON);
    await settle(registry, "c4");
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the stream is replaced by a new message", async () => {
    script = waitForStop;
    const ok = vi.fn();
    start(registry, "c5", ok);
    await tick();
    signal.stopped = true;
    registry.cancelStream("c5", STREAM_REPLACED_REASON);
    await settle(registry, "c5");
    expect(ok).not.toHaveBeenCalled();
  });

  it("a throwing callback never breaks the stream", async () => {
    script = async function* () {
      yield { type: "text-delta", payload: { text: "x" } };
    };
    start(registry, "c6", () => {
      throw new Error("telemetry blew up");
    });
    await settle(registry, "c6");
    expect(registry.isStreamRunning("c6")).toBe(false);
  });
});
