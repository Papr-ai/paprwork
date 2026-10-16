/**
 * In-process pub/sub for app-agent SSE turns (desktop + cloud host).
 */

import type { AppAgentChatSseEvent } from "../../../core/types/appAgentChat.js";

interface TurnChannel {
  events: AppAgentChatSseEvent[];
  listeners: Set<(event: AppAgentChatSseEvent) => void>;
  done: boolean;
  error?: string;
  cancel?: () => void;
}

export class AppAgentChatTurnHub {
  private readonly turns = new Map<string, TurnChannel>();

  createTurn(turnId: string): void {
    this.turns.set(turnId, {
      events: [],
      listeners: new Set(),
      done: false,
    });
  }

  publish(turnId: string, event: AppAgentChatSseEvent): void {
    const channel = this.turns.get(turnId);
    if (!channel) {
      return;
    }
    channel.events.push(event);
    for (const listener of channel.listeners) {
      listener(event);
    }
    if (event.type === "app-agent:turn-done" || event.type === "app-agent:error") {
      channel.done = true;
      if (event.type === "app-agent:error" && typeof event.data.error === "string") {
        channel.error = event.data.error;
      }
    }
  }

  subscribe(
    turnId: string,
    listener: (event: AppAgentChatSseEvent) => void,
  ): () => void {
    const channel = this.turns.get(turnId);
    if (!channel) {
      return () => {};
    }
    for (const event of channel.events) {
      listener(event);
    }
    channel.listeners.add(listener);
    return () => {
      channel.listeners.delete(listener);
    };
  }

  isDone(turnId: string): boolean {
    return this.turns.get(turnId)?.done ?? false;
  }

  registerCancel(turnId: string, cancel: () => void): void {
    const channel = this.turns.get(turnId);
    if (channel) {
      channel.cancel = cancel;
    }
  }

  cancelTurn(turnId: string): boolean {
    const channel = this.turns.get(turnId);
    if (!channel || channel.done) {
      return false;
    }
    channel.cancel?.();
    channel.done = true;
    const event: AppAgentChatSseEvent = {
      type: "app-agent:turn-done",
      data: { turnId, assistantText: "", shouldRefreshApp: false, stopped: true },
    };
    channel.events.push(event);
    for (const listener of channel.listeners) {
      listener(event);
    }
    return true;
  }

  removeTurn(turnId: string): void {
    this.turns.delete(turnId);
  }
}

let hub: AppAgentChatTurnHub | null = null;

export function getAppAgentChatTurnHub(): AppAgentChatTurnHub {
  if (!hub) {
    hub = new AppAgentChatTurnHub();
  }
  return hub;
}

function sseClosed(res: import("express").Response): boolean {
  return res.writableEnded || res.destroyed;
}

function writeSse(res: import("express").Response, event: AppAgentChatSseEvent): void {
  // A write after end() throws asynchronously and, unhandled, kills the whole
  // host process (seen when the gateway emits a second terminal event).
  if (sseClosed(res)) return;
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

export function streamTurnEvents(
  res: import("express").Response,
  turnId: string,
  hubInstance: AppAgentChatTurnHub,
): () => void {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");

  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: () => void = () => {};
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    unsubscribe();
    if (keepAlive) clearInterval(keepAlive);
    if (!sseClosed(res)) res.end();
  };
  res.on("error", () => finish());
  res.on("close", () => finish());

  unsubscribe = hubInstance.subscribe(turnId, (event) => {
    if (finished) return;
    writeSse(res, event);
    if (event.type === "app-agent:turn-done" || event.type === "app-agent:error") {
      finish();
    }
  });
  if (finished) unsubscribe(); // replayed a terminal event during subscribe

  keepAlive = setInterval(() => {
    if (!hubInstance.isDone(turnId) && !sseClosed(res)) {
      res.write(": keepalive\n\n");
    }
  }, 25_000);
  if (finished) clearInterval(keepAlive);

  return () => {
    unsubscribe();
    clearInterval(keepAlive);
    hubInstance.removeTurn(turnId);
  };
}
