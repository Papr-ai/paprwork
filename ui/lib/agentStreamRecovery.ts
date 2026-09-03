/**
 * Module-level agent stream recovery state.
 * Survives ChatContainer unmount so reconnect can resume or clear stale UI.
 */

import type { MutableRefObject } from "react";
import { useChatStore } from "../stores/chatStore";
import { gateway, GATEWAY_DISCONNECTED_ERROR } from "../src/lib/gateway";
import type { StreamChunk } from "../types/core";
import type { ChatMessage, SequenceItem } from "../types/chat";
import type { ToolCall } from "../types/core";

export type StreamChunkHandler = (chunk: StreamChunk) => void;

/** In-memory streaming refs keyed by chatId — survives ChatContainer unmount */
export interface StreamingRefs {
  streamingMessageIdRef: MutableRefObject<Map<string, string>>;
  streamingContentRef: MutableRefObject<Map<string, string>>;
  streamingReasoningRef: MutableRefObject<Map<string, string>>;
  toolCallsMapRef: MutableRefObject<Map<string, Map<string, ToolCall>>>;
  sequenceRef: MutableRefObject<
    Map<string, Array<{ type: "text" | "tool" | "thinking"; data: unknown }>>
  >;
  currentTextSegmentRef: MutableRefObject<Map<string, string>>;
}

/** Restore streaming refs from persisted chat store (after tab switch / remount) */
export function rehydrateStreamingRefsForChat(
  chatId: string,
  refs: StreamingRefs,
): string | undefined {
  const existingId = refs.streamingMessageIdRef.current.get(chatId);
  if (existingId) return existingId;

  const chatState = useChatStore.getState().chatStates.get(chatId);
  const streamingMsg = chatState?.messages.find(
    (m) => m.role === "assistant" && m.isStreaming,
  );
  if (!streamingMsg) return undefined;

  refs.streamingMessageIdRef.current.set(chatId, streamingMsg.id);
  refs.streamingContentRef.current.set(
    chatId,
    streamingMsg.streamingContent ?? streamingMsg.content ?? "",
  );
  refs.streamingReasoningRef.current.set(
    chatId,
    streamingMsg.streamingReasoning ?? streamingMsg.reasoning ?? "",
  );

  if (streamingMsg.sequence && streamingMsg.sequence.length > 0) {
    refs.sequenceRef.current.set(chatId, streamingMsg.sequence as SequenceItem[]);
  }

  if (streamingMsg.toolCalls && streamingMsg.toolCalls.length > 0) {
    const map = new Map<string, ToolCall>();
    for (const tc of streamingMsg.toolCalls) {
      map.set(tc.id, tc);
    }
    refs.toolCallsMapRef.current.set(chatId, map);
  }

  return streamingMsg.id;
}

/** Hidden user message sent when Resume must start a new agent turn */
export const HIDDEN_CONTINUE_USER_PREFIX = "[__papr_continue__]";

export const HIDDEN_CONTINUE_USER_MESSAGE = `${HIDDEN_CONTINUE_USER_PREFIX} Continue your previous response from where you left off. Do not repeat work you already completed. Pick up seamlessly.`;

export function isHiddenContinueUserMessage(content: string): boolean {
  return content.startsWith(HIDDEN_CONTINUE_USER_PREFIX);
}

export function assistantMessageHasContent(message: ChatMessage): boolean {
  if (message.isStreaming) return false;
  if (message.content.trim().length > 0) return true;
  if (message.toolCalls && message.toolCalls.length > 0) return true;
  if (message.sequence && message.sequence.length > 0) return true;
  return false;
}

/**
 * Whether a late `done` / `agent:complete` chunk should be skipped.
 * Only ignore when the server-assigned message is already in the UI — not merely
 * because an older assistant message exists (that blocked new responses).
 */
export function shouldIgnoreDuplicateDoneChunk(args: {
  finalMessageId: string;
  messages: ChatMessage[];
  hasActiveStreamingMessageId: boolean;
  isSending: boolean;
}): boolean {
  if (args.hasActiveStreamingMessageId || args.isSending) {
    return false;
  }
  return args.messages.some(
    (m) => m.id === args.finalMessageId && !m.isStreaming,
  );
}

/** True when the last visible user turn has no completed assistant response */
export function lastUserTurnNeedsContinue(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (isHiddenContinueUserMessage(message.content)) continue;

    const after = messages.slice(i + 1);
    const hasCompleteAssistant = after.some(
      (m) => m.role === "assistant" && assistantMessageHasContent(m),
    );
    return !hasCompleteAssistant;
  }
  return false;
}

/** True when a stream was interrupted mid-turn and should be continued on Resume */
export function interruptedTurnNeedsContinue(
  mergedMessages: ChatMessage[],
  streamingMessageId: string | undefined,
  serverHasReplacement: boolean,
): boolean {
  const hadInterruptedPartial =
    !!streamingMessageId &&
    !serverHasReplacement &&
    mergedMessages.some((m) => m.id === streamingMessageId);

  return hadInterruptedPartial || lastUserTurnNeedsContinue(mergedMessages);
}

/**
 * Close out messages left mid-stream. Every caller reaches here because a turn was
 * abandoned rather than completed, so the partial is flagged `interrupted` — without
 * it the truncated work renders identically to a finished answer, and any tool still
 * "calling" would keep the card spinning forever.
 */
export function finalizeStreamingMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.isStreaming) return message;
    const content = message.streamingContent ?? message.content ?? "";
    const reasoning = message.streamingReasoning ?? message.reasoning;
    return {
      ...message,
      isStreaming: false,
      interrupted: true,
      content: content || message.content,
      ...(reasoning ? { reasoning } : {}),
      ...(message.sequence
        ? { sequence: settleUnfinishedToolCalls(message.sequence) }
        : {}),
      streamingContent: undefined,
      streamingReasoning: undefined,
    };
  });
}

/** A tool that never reported back cannot be left as "calling". */
function settleUnfinishedToolCalls(
  sequence: NonNullable<ChatMessage["sequence"]>,
): NonNullable<ChatMessage["sequence"]> {
  return sequence.map((item) => {
    if (item.type !== "tool") return item;
    const data = item.data as { status?: string } | undefined;
    if (!data || data.status !== "calling") return item;
    return { ...item, data: { ...data, status: "interrupted" } };
  });
}

/** Merge server history without dropping unsaved partial assistant work */
export function serverHasCompletedAssistantForStreamingTurn(
  localMessages: ChatMessage[],
  serverMessages: ChatMessage[],
  streamingMessageId: string,
): boolean {
  const streamIdx = localMessages.findIndex((m) => m.id === streamingMessageId);
  if (streamIdx < 0) return false;

  let triggeringUser: ChatMessage | undefined;
  for (let i = streamIdx - 1; i >= 0; i--) {
    if (localMessages[i]?.role === "user") {
      triggeringUser = localMessages[i];
      break;
    }
  }
  if (!triggeringUser) return false;

  const userContent = triggeringUser.content.trim();
  const userIdxOnServer = serverMessages.findIndex(
    (m) => m.role === "user" && m.content.trim() === userContent,
  );
  if (userIdxOnServer < 0) return false;

  return serverMessages
    .slice(userIdxOnServer + 1)
    .some((m) => m.role === "assistant" && !m.isStreaming);
}

function upgradeAssistantFromServer(
  local: ChatMessage,
  serverMsg: ChatMessage,
): ChatMessage {
  const localRichness =
    (local.sequence?.length ?? 0) + (local.toolCalls?.length ?? 0);
  const serverRichness =
    (serverMsg.sequence?.length ?? 0) + (serverMsg.toolCalls?.length ?? 0);
  const shouldUpgrade =
    serverRichness > localRichness ||
    (!local.sequence?.length && !!serverMsg.sequence?.length) ||
    (!local.toolCalls?.length && !!serverMsg.toolCalls?.length);

  if (!shouldUpgrade) {
    return {
      ...local,
      isStreaming: false,
      streamingContent: undefined,
      streamingReasoning: undefined,
    };
  }

  return {
    ...serverMsg,
    isStreaming: false,
    streamingContent: undefined,
    streamingReasoning: undefined,
  };
}

export function mergeHistoryWithLocal(
  localMessages: ChatMessage[],
  serverMessages: ChatMessage[],
  streamingMessageId?: string,
): ChatMessage[] {
  let base = localMessages;
  if (
    streamingMessageId &&
    serverHasCompletedAssistantForStreamingTurn(
      localMessages,
      serverMessages,
      streamingMessageId,
    )
  ) {
    base = localMessages.filter((m) => m.id !== streamingMessageId);
  }

  const merged: ChatMessage[] = [];
  const consumedLocalIds = new Set<string>();

  // Server list is chronological — walk it so missing middle turns land in order.
  for (const serverMsg of serverMessages) {
    const localById = base.find((m) => m.id === serverMsg.id);
    if (localById) {
      merged.push(
        localById.role === "assistant"
          ? upgradeAssistantFromServer(localById, serverMsg)
          : localById,
      );
      consumedLocalIds.add(localById.id);
      continue;
    }

    if (serverMsg.role === "user") {
      const localDup = base.find(
        (m) =>
          m.role === "user" &&
          !consumedLocalIds.has(m.id) &&
          m.content.trim() === serverMsg.content.trim(),
      );
      if (localDup) {
        merged.push({
          ...localDup,
          ...(serverMsg.attachments?.length && !localDup.attachments?.length
            ? { attachments: serverMsg.attachments }
            : {}),
        });
        consumedLocalIds.add(localDup.id);
        continue;
      }
    }

    if (serverMsg.role === "assistant") {
      const localDup = base.find(
        (m) =>
          m.role === "assistant" &&
          !m.isStreaming &&
          !consumedLocalIds.has(m.id) &&
          m.content.trim() === serverMsg.content.trim() &&
          serverMsg.content.trim().length > 0,
      );
      if (localDup) {
        merged.push(upgradeAssistantFromServer(localDup, serverMsg));
        consumedLocalIds.add(localDup.id);
        continue;
      }
    }

    merged.push(serverMsg);
  }

  // Optimistic user sends + in-flight streaming placeholders not on server yet.
  for (const localMsg of base) {
    if (consumedLocalIds.has(localMsg.id)) continue;
    merged.push(localMsg);
  }

  return merged;
}

/**
 * True when a live stream is in flight and applying server history would wipe
 * partial UI state. Does NOT treat needsStreamRecovery as blocking — recovery
 * mode needs a server reload to repopulate missing assistant turns.
 */
export function chatHasLiveStreamBlockingHistory(chatId: string): boolean {
  const chatState = useChatStore.getState().chatStates.get(chatId);
  if (!chatState) return false;

  const hasActiveRequest =
    activeStreamRequests.has(chatId) || isResumingStream(chatId);

  if (chatState.isSending && hasActiveRequest) return true;
  if (hasActiveRequest && chatState.connectionPaused === true) return true;
  if (
    hasActiveRequest &&
    chatState.messages.some((m) => m.isStreaming) === true
  ) {
    return true;
  }

  return false;
}

/** True when chat has an active or interrupted stream worth preserving in UI */
export function chatHasActiveStreamUi(chatId: string): boolean {
  const chatState = useChatStore.getState().chatStates.get(chatId);
  if (!chatState) return false;
  return (
    chatHasLiveStreamBlockingHistory(chatId) ||
    chatState.needsStreamRecovery === true ||
    chatState.messages.some((m) => m.isStreaming) === true
  );
}

/** Placeholder requestId — gateway resolves to the active stream for chatId */
export const RESUME_STREAM_PLACEHOLDER = "resume";

/** Active stream request IDs keyed by chatId */
export const activeStreamRequests = new Map<string, string>();

export async function chatIsStreamingOnServer(chatId: string): Promise<boolean> {
  try {
    const sessionsResp = await gateway.send("agent:sessions", {});
    const sessions =
      (
        sessionsResp.data as {
          sessions?: Array<{ chatId: string; isStreaming: boolean }>;
        }
      )?.sessions ?? [];
    return sessions.some((s) => s.chatId === chatId && s.isStreaming);
  } catch {
    return false;
  }
}

export function ensureTrackedStream(chatId: string): string {
  const existing = activeStreamRequests.get(chatId);
  if (existing) return existing;
  trackActiveStream(chatId, RESUME_STREAM_PLACEHOLDER);
  return RESUME_STREAM_PLACEHOLDER;
}

/** Chunks already applied — subscribe replays from this index */
export const appliedChunkCounts = new Map<string, number>();

const resumingStreams = new Set<string>();
const resumeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

type RecoverStreamsFn = () => Promise<void>;
let recoverStreamsAfterReconnect: RecoverStreamsFn | null = null;
let gatewayRecoveryRegistered = false;

export function trackActiveStream(chatId: string, requestId: string): void {
  activeStreamRequests.set(chatId, requestId);
}

export function untrackActiveStream(chatId: string): void {
  activeStreamRequests.delete(chatId);
  appliedChunkCounts.delete(chatId);
  clearResumeRetry(chatId);
  cancelSubscribeHandler(chatId);
}

export function clearResumeRetry(chatId: string): void {
  const timer = resumeRetryTimers.get(chatId);
  if (timer) {
    clearTimeout(timer);
    resumeRetryTimers.delete(chatId);
  }
}

export function isResumingStream(chatId: string): boolean {
  return resumingStreams.has(chatId);
}

export async function clearStalePausedChats(): Promise<void> {
  await clearStaleConnectionPaused();
}

export function markResuming(chatId: string, resuming: boolean): void {
  if (resuming) {
    resumingStreams.add(chatId);
  } else {
    resumingStreams.delete(chatId);
  }
}

export function setRecoverStreamsHandler(handler: RecoverStreamsFn | null): void {
  recoverStreamsAfterReconnect = handler;
}

function pauseChatsOnDisconnect(): void {
  for (const chatId of activeStreamRequests.keys()) {
    useChatStore.getState().setConnectionPaused(chatId, true);
  }
  if (activeStreamRequests.size === 0) {
    useChatStore.getState().setError("Gateway not connected");
  }
}

async function clearStaleConnectionPaused(): Promise<void> {
  const store = useChatStore.getState();
  for (const [chatId, state] of store.chatStates.entries()) {
    const isStale =
      !resumingStreams.has(chatId) && !activeStreamRequests.has(chatId);

    // Clear connectionPaused on stale chats
    if (state.connectionPaused && isStale) {
      store.setConnectionPaused(chatId, false);
    }

    // Clear isSending on stale chats
    if (state.isSending && isStale) {
      store.setSending(chatId, false);
    }

    // Clear orphaned isStreaming state — if no active stream exists on
    // the client, the chat shouldn't show "Working". Also finalize any
    // in-memory streaming messages so the user sees what was accumulated.
    if (state.isStreaming && isStale) {
      store.setChatStreaming(chatId, false);
      store.clearStreamingState(chatId);

      // Finalize any messages still marked isStreaming
      const hasStreamingMsg = state.messages.some((m) => m.isStreaming);
      if (hasStreamingMsg) {
        const newChatStates = new Map(useChatStore.getState().chatStates);
        const current = newChatStates.get(chatId);
        if (current) {
          newChatStates.set(chatId, {
            ...current,
            isStreaming: false,
            messages: finalizeStreamingMessages(current.messages),
          });
          useChatStore.setState({ chatStates: newChatStates });
        }
      }
    }

    // Clear needsStreamRecovery if nothing to recover
    if (state.needsStreamRecovery && isStale) {
      store.setNeedsStreamRecovery(chatId, false);
    }
  }
}

async function recoverAfterReconnect(): Promise<void> {
  if (recoverStreamsAfterReconnect) {
    await recoverStreamsAfterReconnect();
  } else {
    await clearStaleConnectionPaused();
  }
}

export function ensureGatewayRecoveryRegistered(): void {
  if (gatewayRecoveryRegistered) return;
  gatewayRecoveryRegistered = true;

  gateway.onConnectionChange((connected) => {
    if (!connected) {
      pauseChatsOnDisconnect();
      return;
    }

    useChatStore.getState().setError(null);
    void recoverAfterReconnect();
  });
}

/** WebSocket handler ids for agent:subscribe — cancel on interrupt */
export const subscribeWsHandlerIds = new Map<string, string>();

export function cancelSubscribeHandler(chatId: string): void {
  const handlerId = subscribeWsHandlerIds.get(chatId);
  if (!handlerId) return;
  gateway.cancelRequest(handlerId);
  subscribeWsHandlerIds.delete(chatId);
}

export async function subscribeWithRetry(
  chatId: string,
  requestId: string,
  fromChunkIndex: number,
  onChunk: StreamChunkHandler,
  maxAttempts = 8,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await gateway.subscribeStream(
        chatId,
        requestId,
        fromChunkIndex,
        (chunk) => onChunk(chunk as StreamChunk),
        (subscribeHandlerId) => {
          subscribeWsHandlerIds.set(chatId, subscribeHandlerId);
        },
      );
      subscribeWsHandlerIds.delete(chatId);
      return;
    } catch (error) {
      subscribeWsHandlerIds.delete(chatId);
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (message === GATEWAY_DISCONNECTED_ERROR) {
        throw error;
      }
      if (message.includes("Retry shortly") && attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export function scheduleStreamResumeRetry(
  chatId: string,
  requestId: string,
  resume: (chatId: string, requestId: string) => Promise<void>,
): void {
  clearResumeRetry(chatId);

  let attempts = 0;
  const maxAttempts = 15;

  const tick = (): void => {
    if (!gateway.isConnected()) return;
    if (!activeStreamRequests.has(chatId)) return;

    attempts += 1;
    if (attempts > maxAttempts) {
      clearResumeRetry(chatId);
      const store = useChatStore.getState();
      store.setConnectionPaused(chatId, false);
      store.setSending(chatId, false);
      store.setNeedsStreamRecovery(chatId, true);
      return;
    }

    void resume(chatId, requestId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message === GATEWAY_DISCONNECTED_ERROR) return;
      const timer = setTimeout(tick, 2000);
      resumeRetryTimers.set(chatId, timer);
    });
  };

  const timer = setTimeout(tick, 1000);
  resumeRetryTimers.set(chatId, timer);
}
