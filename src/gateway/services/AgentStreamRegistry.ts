/**
 * AgentStreamRegistry — decouples agent streaming from WebSocket lifetime.
 *
 * When the UI disconnects (sleep, network blip), the agent keeps running.
 * Reconnecting clients replay buffered chunks and subscribe to live updates.
 */

import type { WebSocket } from "ws";
import type { AgentConfigInternal } from "../../core/types/agents.js";
import type { UiAgentFocusContext } from "../../core/types/agentFocus.js";
import type { StreamChunk } from "../../core/types/streaming.js";
import {
  isExpectedStreamCancellation,
  STREAM_REPLACED_REASON,
  STREAM_STOPPED_REASON,
} from "../../core/constants/streamCancellation.js";

const STREAM_TTL_MS = 10 * 60 * 1000;

interface StreamSubscriber {
  ws: WebSocket;
  responseId: string;
}

interface ActiveStream {
  chatId: string;
  requestId: string;
  chunks: Array<StreamChunk & { chatId: string }>;
  subscribers: Map<WebSocket, StreamSubscriber>;
  status: "running" | "complete" | "error";
  cancelled?: boolean;
  completeData?: {
    chatId: string;
    done: boolean;
    finalMessage: unknown;
  };
  errorData?: { chatId: string; error: string };
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

function wsOpen(ws: WebSocket): boolean {
  return ws.readyState === ws.OPEN;
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (!wsOpen(ws)) return;
  ws.send(JSON.stringify(payload));
}

function sendChunk(
  ws: WebSocket,
  responseId: string,
  chunk: StreamChunk & { chatId: string },
): void {
  sendJson(ws, { id: responseId, type: "agent:chunk", data: chunk });
}

function sendComplete(
  ws: WebSocket,
  responseId: string,
  data: ActiveStream["completeData"],
): void {
  sendJson(ws, {
    id: responseId,
    type: "agent:complete",
    success: true,
    data,
  });
}

function sendError(
  ws: WebSocket,
  responseId: string,
  data: ActiveStream["errorData"],
): void {
  sendJson(ws, {
    id: responseId,
    type: "agent:error",
    success: false,
    data,
  });
}

export class AgentStreamRegistry {
  private streamsByRequestId = new Map<string, ActiveStream>();
  private requestIdByChatId = new Map<string, string>();

  getRequestIdForChat(chatId: string): string | undefined {
    return this.requestIdByChatId.get(chatId);
  }

  isStreamRunning(chatId: string): boolean {
    const requestId = this.requestIdByChatId.get(chatId);
    if (!requestId) return false;
    return this.streamsByRequestId.get(requestId)?.status === "running";
  }

  addSubscriber(
    ws: WebSocket,
    responseId: string,
    chatId: string,
    requestId: string,
    fromChunkIndex = 0,
  ): { found: boolean; replayed: number; totalBuffered: number } {
    const entry = this.streamsByRequestId.get(requestId);
    if (!entry || entry.chatId !== chatId) {
      return { found: false, replayed: 0, totalBuffered: 0 };
    }

    entry.subscribers.set(ws, { ws, responseId });

    const startIndex = Math.max(0, Math.min(fromChunkIndex, entry.chunks.length));
    for (let i = startIndex; i < entry.chunks.length; i++) {
      sendChunk(ws, responseId, entry.chunks[i]);
    }

    if (entry.status === "complete" && entry.completeData) {
      sendComplete(ws, responseId, entry.completeData);
      entry.subscribers.delete(ws);
    } else if (entry.status === "error" && entry.errorData) {
      sendError(ws, responseId, entry.errorData);
      entry.subscribers.delete(ws);
    }

    return {
      found: true,
      replayed: entry.chunks.length - startIndex,
      totalBuffered: entry.chunks.length,
    };
  }

  removeSubscriber(ws: WebSocket): void {
    for (const entry of this.streamsByRequestId.values()) {
      entry.subscribers.delete(ws);
    }
  }

  /**
   * Cancel an in-flight stream for a chat and optionally notify subscribers.
   * Silent cancel is used for user stop / replacement — not an error condition.
   */
  cancelStream(
    chatId: string,
    reason = STREAM_STOPPED_REASON,
    options?: { silent?: boolean },
  ): void {
    const requestId = this.requestIdByChatId.get(chatId);
    if (!requestId) return;

    const entry = this.streamsByRequestId.get(requestId);
    if (!entry) {
      this.requestIdByChatId.delete(chatId);
      return;
    }

    if (entry.status === "running") {
      entry.cancelled = true;
      const silent =
        options?.silent === true || isExpectedStreamCancellation(reason);
      if (!silent) {
        entry.status = "error";
        entry.errorData = { chatId, error: reason };
        this.broadcastError(entry);
      }
      console.log(
        `[AgentStreamRegistry] Cancelled stream ${requestId} for chat ${chatId}: ${reason}` +
          (silent ? " (silent)" : ""),
      );
    }

    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
    }
    this.streamsByRequestId.delete(requestId);
    if (this.requestIdByChatId.get(chatId) === requestId) {
      this.requestIdByChatId.delete(chatId);
    }
  }

  startStream(params: {
    chatId: string;
    requestId: string;
    userMessage: string;
    config: AgentConfigInternal;
    focusContext?: UiAgentFocusContext;
    ws: WebSocket;
  }): void {
    const { chatId, requestId, userMessage, config, focusContext, ws } = params;

    const existingRequestId = this.requestIdByChatId.get(chatId);
    if (existingRequestId) {
      const existing = this.streamsByRequestId.get(existingRequestId);
      if (existing?.status === "running") {
        console.warn(
          `[AgentStreamRegistry] Chat ${chatId} already streaming (${existingRequestId}), cancelling before new stream`,
        );
        void import("./AgentService.js").then(({ getAgentService }) =>
          getAgentService().stopStreaming(chatId),
        );
        this.cancelStream(chatId, STREAM_REPLACED_REASON);
      }
    }

    const entry: ActiveStream = {
      chatId,
      requestId,
      chunks: [],
      subscribers: new Map(),
      status: "running",
    };

    entry.subscribers.set(ws, { ws, responseId: requestId });
    this.streamsByRequestId.set(requestId, entry);
    this.requestIdByChatId.set(chatId, requestId);

    void this.runStream(entry, userMessage, config, focusContext);
  }

  private async runStream(
    entry: ActiveStream,
    userMessage: string,
    config: AgentConfigInternal,
    focusContext?: UiAgentFocusContext,
  ): Promise<void> {
    const { getAgentService } = await import("./AgentService.js");
    const agentService = getAgentService();
    const { chatId, requestId } = entry;

    try {
      const { runWithToolContext } = await import(
        "../../core/tools/context.js"
      );

      await runWithToolContext(chatId, async () => {
        for await (const chunk of agentService.streamAgent(
          chatId,
          userMessage,
          config,
          { focusContext },
        )) {
          if (entry.cancelled) break;
          entry.chunks.push(chunk);
          this.broadcastChunk(entry, chunk);
        }
      });

      if (entry.cancelled) {
        console.log(
          `[AgentStreamRegistry] Stream ${requestId} aborted for chat ${chatId}`,
        );
        try {
          const messages = await agentService.getChatHistory(chatId);
          const finalMessage = messages[messages.length - 1];
          if (finalMessage?.role === "assistant") {
            entry.status = "complete";
            entry.completeData = {
              chatId,
              done: true,
              finalMessage,
            };
            this.broadcastComplete(entry);
          }
        } catch (historyError) {
          console.warn(
            `[AgentStreamRegistry] Failed to load history after cancel for ${chatId}:`,
            historyError,
          );
        }
        return;
      }

      const messages = await agentService.getChatHistory(chatId);
      const finalMessage = messages[messages.length - 1];

      entry.status = "complete";
      entry.completeData = {
        chatId,
        done: true,
        finalMessage,
      };

      this.broadcastComplete(entry);
      console.log(
        `[AgentStreamRegistry] Stream complete for chat ${chatId} (${entry.chunks.length} chunks buffered)`,
      );
    } catch (streamError) {
      console.error(
        `[AgentStreamRegistry] Stream error for chat ${chatId}:`,
        streamError,
      );

      entry.status = "error";
      entry.errorData = {
        chatId,
        error:
          streamError instanceof Error
            ? streamError.message
            : "Stream error",
      };

      this.broadcastError(entry);
    } finally {
      this.scheduleCleanup(requestId);
    }
  }

  private broadcastChunk(
    entry: ActiveStream,
    chunk: StreamChunk & { chatId: string },
  ): void {
    if (entry.cancelled || entry.status !== "running") return;
    for (const sub of entry.subscribers.values()) {
      sendChunk(sub.ws, sub.responseId, chunk);
    }
  }

  private broadcastComplete(entry: ActiveStream): void {
    if (!entry.completeData) return;
    for (const sub of entry.subscribers.values()) {
      sendComplete(sub.ws, sub.responseId, entry.completeData);
    }
    entry.subscribers.clear();
  }

  private broadcastError(entry: ActiveStream): void {
    if (!entry.errorData) return;
    for (const sub of entry.subscribers.values()) {
      sendError(sub.ws, sub.responseId, entry.errorData);
    }
    entry.subscribers.clear();
  }

  private scheduleCleanup(requestId: string): void {
    const entry = this.streamsByRequestId.get(requestId);
    if (!entry) return;

    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
    }

    entry.cleanupTimer = setTimeout(() => {
      const current = this.streamsByRequestId.get(requestId);
      if (!current) return;
      this.streamsByRequestId.delete(requestId);
      if (this.requestIdByChatId.get(current.chatId) === requestId) {
        this.requestIdByChatId.delete(current.chatId);
      }
      console.log(
        `[AgentStreamRegistry] Cleaned up stream ${requestId} for chat ${current.chatId}`,
      );
    }, STREAM_TTL_MS);
  }
}

let registryInstance: AgentStreamRegistry | null = null;

export function getAgentStreamRegistry(): AgentStreamRegistry {
  if (!registryInstance) {
    registryInstance = new AgentStreamRegistry();
  }
  return registryInstance;
}
