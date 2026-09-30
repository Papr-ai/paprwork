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
  finishStreamProfiler,
  getStreamProfiler,
} from "../../core/utils/streamProfiler.js";
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

/** Returns false when the socket is not open — the send was a no-op. */
function sendJson(ws: WebSocket, payload: Record<string, unknown>): boolean {
  if (!wsOpen(ws)) return false;
  ws.send(JSON.stringify(payload));
  return true;
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
): boolean {
  return sendJson(ws, {
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
): boolean {
  return sendJson(ws, {
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

  countRunningStreams(): number {
    let count = 0;
    for (const entry of this.streamsByRequestId.values()) {
      if (entry.status === "running") {
        count += 1;
      }
    }
    return count;
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

  /**
   * A socket closed. Dropping it used to be silent, which meant a running turn
   * could lose its last listener with nothing in the log to say so — and the
   * completion then had nobody to go to. Say it, so the log shows the loss
   * before the completion rather than only the absence of one.
   */
  removeSubscriber(ws: WebSocket): void {
    for (const entry of this.streamsByRequestId.values()) {
      if (!entry.subscribers.delete(ws)) continue;
      if (entry.status === "running" && entry.subscribers.size === 0) {
        console.warn(
          `[AgentStreamRegistry] Running stream ${entry.requestId} for chat ` +
            `${entry.chatId} lost its last subscriber. The turn continues; ` +
            `its result will be broadcast if nobody resubscribes.`,
        );
      }
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
    attachments?: import("./storage/IStorageProvider.js").StoredMessageAttachment[];
    reuseAssistantMessageId?: string;
    ws: WebSocket;
  }): void {
    const {
      chatId,
      requestId,
      userMessage,
      config,
      focusContext,
      attachments,
      reuseAssistantMessageId,
      ws,
    } = params;

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
      .then(() =>
        this.runStream(
          entry,
          userMessage,
          config,
          focusContext,
          attachments,
          reuseAssistantMessageId,
        ),
      )
      .catch((error) => {
        console.error(
          `[AgentStreamRegistry] Failed to stop previous stream for ${chatId}:`,
          error,
        );
        return this.runStream(
          entry,
          userMessage,
          config,
          focusContext,
          attachments,
          reuseAssistantMessageId,
        );
      });
  }

  private async runStream(
    entry: ActiveStream,
    userMessage: string,
    config: AgentConfigInternal,
    focusContext?: UiAgentFocusContext,
    attachments?: import("./storage/IStorageProvider.js").StoredMessageAttachment[],
    reuseAssistantMessageId?: string,
  ): Promise<void> {
    const { getAgentService } = await import("./AgentService.js");
    const agentService = getAgentService();
    const { chatId, requestId } = entry;

    // The last error the model stream actually explained. Kept so a trailing
    // NoOutputGeneratedError cannot replace it with a description of its own
    // side effect.
    let reportedModelError: string | undefined;

    const { withInteractiveHotPath } = await import(
      "./gatewayInteractivePriority.js"
    );

    try {
      getStreamProfiler(chatId)?.mark("registry.runStream.start");

      const { runWithToolContext } = await import(
        "../../core/tools/context.js"
      );

      await withInteractiveHotPath("agent:stream", async () =>
        runWithToolContext(chatId, async () => {
        for await (const chunk of agentService.streamAgent(
          chatId,
          userMessage,
          config,
          {
            focusContext,
            attachments,
            ...(reuseAssistantMessageId
              ? { _reuseAssistantMessageId: reuseAssistantMessageId }
              : {}),
          },
        )) {
          if (entry.cancelled) break;
          if (chunk.type === "error") {
            const reported = (chunk.payload as { error?: unknown } | undefined)
              ?.error;
            if (typeof reported === "string" && reported.trim().length > 0) {
              reportedModelError = reported;
            }
          }
          this.bufferChunk(entry, chunk);
          this.broadcastChunk(entry, chunk);
          this.tryCompleteFromDoneChunk(entry, chunk);
        }
        }),
      );

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

      if (entry.status !== "complete") {
        const messages = await agentService.getChatHistory(chatId);
        const finalMessage = messages[messages.length - 1];

        entry.status = "complete";
        entry.completeData = {
          chatId,
          done: true,
          finalMessage,
        };

        this.broadcastComplete(entry);
      }
      console.log(
        `[AgentStreamRegistry] Stream complete for chat ${chatId} (${entry.chunks.length} chunks buffered)`,
      );
    } catch (streamError) {
      const { isNoOutputGeneratedError } = await import(
        "./agent/providerErrorMessage.js"
      );

      // Prefer the error we already explained. NoOutputGeneratedError only
      // tells us the stream produced no steps, which we can already see.
      const preferReported =
        reportedModelError !== undefined &&
        isNoOutputGeneratedError(streamError);

      if (preferReported) {
        console.error(
          `[AgentStreamRegistry] Stream error for chat ${chatId}: ` +
            `reporting the model error instead of the trailing ` +
            `NoOutputGeneratedError: ${reportedModelError}`,
        );
      } else {
        console.error(
          `[AgentStreamRegistry] Stream error for chat ${chatId}:`,
          streamError,
        );
      }

      entry.status = "error";
      entry.errorData = {
        chatId,
        error: preferReported
          ? (reportedModelError as string)
          : streamError instanceof Error
            ? streamError.message
            : "Stream error",
      };

      this.broadcastError(entry);
    } finally {
      getStreamProfiler(chatId)?.mark("registry.runStream.end");
      finishStreamProfiler(chatId, { requestId });

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
    const tracked = entry.subscribers.size;
    let delivered = 0;
    for (const sub of entry.subscribers.values()) {
      if (sendComplete(sub.ws, sub.responseId, entry.completeData)) {
        delivered += 1;
      }
    }
    entry.subscribers.clear();
    if (delivered === 0) {
      this.reportUndeliveredTerminalState(
        entry,
        "agent:complete",
        entry.completeData,
        tracked,
      );
    }
  }

  /**
   * The UI treats `done` as turn-complete, but streamAgent keeps running
   * (export, summarization scheduling) before the for-await loop ends.
   * Without an early complete, the renderer waits on agent:complete while
   * isSending is already false — the next send blocks on the prior lock.
   */
  private tryCompleteFromDoneChunk(
    entry: ActiveStream,
    chunk: StreamChunk & { chatId: string },
  ): void {
    if (entry.status === "complete" || chunk.type !== "done") {
      return;
    }
    const payload = (chunk as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") {
      return;
    }
    const finalMessage = (payload as { finalMessage?: unknown }).finalMessage;
    if (!finalMessage || typeof finalMessage !== "object") {
      return;
    }
    entry.status = "complete";
    entry.completeData = {
      chatId: entry.chatId,
      done: true,
      finalMessage,
    };
    this.broadcastComplete(entry);
  }

  private broadcastError(entry: ActiveStream): void {
    if (!entry.errorData) return;
    const tracked = entry.subscribers.size;
    let delivered = 0;
    for (const sub of entry.subscribers.values()) {
      if (sendError(sub.ws, sub.responseId, entry.errorData)) {
        delivered += 1;
      }
    }
    entry.subscribers.clear();
    if (delivered === 0) {
      this.reportUndeliveredTerminalState(
        entry,
        "agent:error",
        entry.errorData,
        tracked,
      );
    }
  }

  /**
   * A finished turn that reached nobody. Two ways to get here: the subscriber
   * list is empty (the socket closed, so `removeSubscriber` dropped it), or it
   * is non-empty but every socket is closing — `sendJson` is a silent no-op on
   * a socket that is not open, which is why this used to leave no trace at all
   * and had to be diagnosed by querying the database.
   *
   * Log it, then fall back to a workspace broadcast keyed by chatId so any
   * other live client — a second window, or the same client on a socket it
   * reopened without resubscribing — can still finish the turn. Same mechanism
   * and same payload shape SubAgentResponseTrigger already uses for completions
   * with no requesting socket.
   */
  private reportUndeliveredTerminalState(
    entry: ActiveStream,
    type: "agent:complete" | "agent:error",
    data: ActiveStream["completeData"] | ActiveStream["errorData"],
    trackedSubscribers: number,
  ): void {
    console.warn(
      `[AgentStreamRegistry] ${type} for chat ${entry.chatId} ` +
        `(stream ${entry.requestId}) reached no open subscriber ` +
        `(${trackedSubscribers} tracked, 0 open). The turn is persisted — ` +
        `falling back to a workspace broadcast so a live client can render it.`,
    );

    void import("../websocket/index.js")
      .then(({ broadcast }) => {
        broadcast({ type, data });
      })
      .catch((error) => {
        console.error(
          `[AgentStreamRegistry] Broadcast fallback failed for chat ${entry.chatId}:`,
          error,
        );
      });
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
