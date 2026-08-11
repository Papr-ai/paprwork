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

// ── Memory safety caps for the live replay buffer ──────────────────────
// Without these, a heavy multi-tool turn can buffer 50MB+ of chunks per
// stream (tool results are stored full-size), and 3-4 parallel chats can
// push the gateway process into memory pressure / OOM.
/** Max bytes of buffered chunks per stream before oldest are evicted */
const MAX_BUFFER_BYTES = 25 * 1024 * 1024; // 25MB
/** Max number of buffered chunks per stream */
const MAX_BUFFER_CHUNKS = 2000;

/** Cheap byte-size estimate for a chunk (avoids full JSON.stringify cost) */
function estimateChunkBytes(chunk: StreamChunk & { chatId: string }): number {
  const payload = (chunk as { payload?: unknown }).payload;
  if (payload == null) return 200; // envelope overhead
  if (typeof payload === "string") return payload.length + 200;
  const p = payload as Record<string, unknown>;
  // text-delta / reasoning-delta: dominant field is .text
  if (typeof p.text === "string") return p.text.length + 200;
  // tool-result: dominant field is .result
  if (p.result !== undefined) {
    try {
      return JSON.stringify(p.result).length + 300;
    } catch {
      return 1000;
    }
  }
  try {
    return JSON.stringify(payload).length + 200;
  } catch {
    return 1000;
  }
}

interface StreamSubscriber {
  ws: WebSocket;
  responseId: string;
}

interface ActiveStream {
  chatId: string;
  requestId: string;
  chunks: Array<StreamChunk & { chatId: string }>;
  /** Global index of chunks[0] — increments when old chunks are evicted */
  firstChunkIndex: number;
  /** Running estimate of buffered bytes across chunks[] */
  bufferedBytes: number;
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

    // fromChunkIndex is a GLOBAL index (client counts every chunk it saw).
    // chunks[] may have been evicted at the front — translate to local index.
    const globalTotal = entry.firstChunkIndex + entry.chunks.length;
    const localStart = Math.max(
      0,
      Math.min(fromChunkIndex - entry.firstChunkIndex, entry.chunks.length),
    );
    if (fromChunkIndex < entry.firstChunkIndex) {
      // Gap: client missed evicted chunks. Replay what we still have — the
      // final message (agent:complete / checkpoint history) fills the rest.
      console.warn(
        `[AgentStreamRegistry] Replay gap for chat ${chatId}: client at ` +
          `${fromChunkIndex}, buffer starts at ${entry.firstChunkIndex} ` +
          `(${entry.firstChunkIndex - fromChunkIndex} chunks evicted)`,
      );
    }
    for (let i = localStart; i < entry.chunks.length; i++) {
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
      replayed: entry.chunks.length - localStart,
      totalBuffered: globalTotal,
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
  /** Abort every running stream (e.g. before org/namespace workspace switch). */
  async cancelAllRunningStreams(reason = "Workspace switch"): Promise<void> {
    const chatIds = [...this.requestIdByChatId.keys()];
    if (chatIds.length === 0) {
      return;
    }

    const { getAgentService } = await import("./AgentService.js");
    const agentService = getAgentService();

    await Promise.all(
      chatIds.map(async (chatId) => {
        if (!this.isStreamRunning(chatId)) {
          return;
        }
        await agentService.stopStreaming(chatId);
        this.cancelStream(chatId, reason, { silent: true });
      }),
    );
  }

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

    let previousStreamStopped: Promise<void> = Promise.resolve();
    const existingRequestId = this.requestIdByChatId.get(chatId);
    if (existingRequestId) {
      const existing = this.streamsByRequestId.get(existingRequestId);
      if (existing?.status === "running") {
        console.warn(
          `[AgentStreamRegistry] Chat ${chatId} already streaming (${existingRequestId}), cancelling before new stream`,
        );
        // Abort the old controller before the replacement registers its own.
        // Otherwise a delayed dynamic import can accidentally abort the new stream.
        previousStreamStopped = import("./AgentService.js").then(
          ({ getAgentService }) => getAgentService().stopStreaming(chatId),
        );
        this.cancelStream(chatId, STREAM_REPLACED_REASON);
      }
    }

    const entry: ActiveStream = {
      chatId,
      requestId,
      chunks: [],
      firstChunkIndex: 0,
      bufferedBytes: 0,
      subscribers: new Map(),
      status: "running",
    };

    entry.subscribers.set(ws, { ws, responseId: requestId });
    this.streamsByRequestId.set(requestId, entry);
    this.requestIdByChatId.set(chatId, requestId);

    void previousStreamStopped
      .then(() => this.runStream(entry, userMessage, config, focusContext))
      .catch((error) => {
        console.error(
          `[AgentStreamRegistry] Failed to stop previous stream for ${chatId}:`,
          error,
        );
        return this.runStream(entry, userMessage, config, focusContext);
      });
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
          this.bufferChunk(entry, chunk);
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
      // Stream reached a terminal state (complete/cancelled/error) — free
      // the replay buffer NOW instead of holding it for the 10-min TTL.
      // Late reconnects get agent:complete (finalMessage) or load history.
      this.releaseChunks(entry);
      this.scheduleCleanup(requestId);
    }
  }

  /**
   * Buffer a chunk for replay, enforcing byte + count caps.
   * When over budget, evict oldest chunks (firstChunkIndex tracks the
   * global offset so reconnecting clients translate indices correctly).
   */
  private bufferChunk(
    entry: ActiveStream,
    chunk: StreamChunk & { chatId: string },
  ): void {
    entry.chunks.push(chunk);
    entry.bufferedBytes += estimateChunkBytes(chunk);

    if (
      entry.bufferedBytes > MAX_BUFFER_BYTES ||
      entry.chunks.length > MAX_BUFFER_CHUNKS
    ) {
      let evicted = 0;
      while (
        entry.chunks.length > 1 &&
        (entry.bufferedBytes > MAX_BUFFER_BYTES ||
          entry.chunks.length > MAX_BUFFER_CHUNKS)
      ) {
        const removed = entry.chunks.shift()!;
        entry.bufferedBytes -= estimateChunkBytes(removed);
        entry.firstChunkIndex++;
        evicted++;
      }
      if (evicted > 0) {
        console.warn(
          `[AgentStreamRegistry] Buffer cap hit for chat ${entry.chatId} — ` +
            `evicted ${evicted} oldest chunks (` +
            `${(entry.bufferedBytes / 1024 / 1024).toFixed(1)}MB / ` +
            `${entry.chunks.length} chunks retained). ` +
            `Reconnecting clients recover missed content from history.`,
        );
      }
    }
  }

  /**
   * Free the replay buffer once the stream reaches a terminal state.
   * After completion, completeData.finalMessage (and the persisted
   * checkpoint/history row) is the source of truth — late reconnects get
   * agent:complete + history instead of a chunk replay. This releases
   * potentially tens of MB per stream that used to sit for the full TTL.
   */
  private releaseChunks(entry: ActiveStream): void {
    if (entry.chunks.length === 0) return;
    const mb = (entry.bufferedBytes / 1024 / 1024).toFixed(1);
    entry.firstChunkIndex += entry.chunks.length;
    entry.chunks.length = 0;
    entry.bufferedBytes = 0;
    console.log(
      `[AgentStreamRegistry] Released ~${mb}MB replay buffer for chat ${entry.chatId} (stream ${entry.status})`,
    );
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
