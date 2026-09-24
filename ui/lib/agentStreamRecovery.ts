/**
 * Module-level agent stream recovery state.
 * Survives ChatContainer unmount so reconnect can resume or clear stale UI.
 */

import type { MutableRefObject } from "react";
import { useChatStore } from "../stores/chatStore";
import { gateway, GATEWAY_DISCONNECTED_ERROR } from "../src/lib/gateway";
import type { StreamChunk } from "../types/core";
import type {
  ChatMessage,
  LastTurnOutcome,
  SequenceItem,
  StreamRecoveryReason,
} from "../types/chat";
import type { ToolCall } from "../types/core";
import { dedupeChatMessages } from "../utils/messageDedup";
import { isExpectedStreamCancellation } from "../../src/core/constants/streamCancellation.js";
import { disarmFirstChunkWatchdog } from "./agentFirstChunkWatchdog";
import { recoveryBannerSurvivesStreamEnd } from "./streamRecoveryPersistence";
import { AGENT_INTERRUPT_TIMEOUT_MS } from "../utils/agentSendLifecycle";

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

/**
 * Ensure the in-memory streaming message id has a matching assistant row in the
 * store. Refs survive tab switches and history merges; the message row may not.
 */
export function ensureStreamingAssistantMessageRow(
  chatId: string,
  messageId: string,
  refs: StreamingRefs,
): void {
  const store = useChatStore.getState();
  const chatState = store.chatStates.get(chatId);
  const existing = chatState?.messages.find((m) => m.id === messageId);

  if (existing) {
    if (!existing.isStreaming) {
      store.reactivateAssistantMessage(chatId, messageId);
    }
    return;
  }

  const sequence = refs.sequenceRef.current.get(chatId) ?? [];
  const toolCallsMap = refs.toolCallsMapRef.current.get(chatId);
  const toolCalls = toolCallsMap ? Array.from(toolCallsMap.values()) : [];
  const content = refs.streamingContentRef.current.get(chatId) ?? "";
  const reasoning = refs.streamingReasoningRef.current.get(chatId) ?? "";

  store.addMessage(
    {
      id: messageId,
      role: "assistant",
      content,
      streamingContent: content,
      reasoning,
      streamingReasoning: reasoning,
      isStreaming: true,
      toolCalls,
      sequence: sequence as SequenceItem[],
    },
    chatId,
  );
  store.setChatStreaming(chatId, true);
  store.initStreamingState(chatId, messageId);
}

/** Restore streaming refs from persisted chat store (after tab switch / remount) */
export function rehydrateStreamingRefsForChat(
  chatId: string,
  refs: StreamingRefs,
): string | undefined {
  const existingId = refs.streamingMessageIdRef.current.get(chatId);
  if (existingId) {
    const chatState = useChatStore.getState().chatStates.get(chatId);
    const row = chatState?.messages.find((m) => m.id === existingId);
    if (row) return existingId;
    refs.streamingMessageIdRef.current.delete(chatId);
  }

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

function assistantTurnSettledForQueue(message: ChatMessage): boolean {
  if (message.isStreaming) return false;
  if (assistantMessageHasContent(message)) return true;
  if (message.interrupted === true) return true;
  return assistantMessageWasStopped(message);
}

/**
 * True when the latest visible user message already has a settled assistant
 * turn (completed, interrupted, or explicitly stopped). Queued messages must
 * not send until this is true — otherwise a follow-up can run while the prior
 * answer is still in flight and replies appear out of order.
 */
export function priorUserTurnSettledForQueue(
  messages: ChatMessage[],
): boolean {
  const lastUser = findLastVisibleUserMessage(messages);
  if (!lastUser) return true;

  const lastUserIndex = messages.findIndex((m) => m.id === lastUser.id);
  const after = messages.slice(lastUserIndex + 1);

  for (const message of after) {
    if (
      message.role === "user" &&
      !isHiddenContinueUserMessage(message.content)
    ) {
      return false;
    }
  }

  const assistantAfter = after.find((m) => m.role === "assistant");
  if (!assistantAfter) return false;
  return assistantTurnSettledForQueue(assistantAfter);
}

/** Whether it is safe to auto-send the next queued user message. */
export function shouldDrainMessageQueue(args: {
  chatId: string;
  messages: ChatMessage[];
  isSending: boolean;
  isWaitingForAgentSlot: boolean;
  connectionPaused: boolean;
  needsStreamRecovery: boolean;
  queueTransitionInFlight: boolean;
}): boolean {
  if (args.queueTransitionInFlight || args.isSending) return false;
  if (args.isWaitingForAgentSlot) return false;
  if (args.connectionPaused || args.needsStreamRecovery) return false;
  if (chatHasLiveStreamBlockingHistory(args.chatId)) return false;
  if (activeStreamRequests.has(args.chatId)) return false;
  return priorUserTurnSettledForQueue(args.messages);
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

  if (hadInterruptedPartial || lastUserTurnNeedsContinue(mergedMessages)) {
    return true;
  }

  const lastAssistant = [...mergedMessages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (
    lastAssistant?.interrupted &&
    !assistantMessageWasStopped(lastAssistant)
  ) {
    return true;
  }

  return false;
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
    return markMessageAsInterrupted(message);
  });
}

/** Flag one assistant turn as interrupted and settle in-flight tools. */
export function markMessageAsInterrupted(message: ChatMessage): ChatMessage {
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
}

export function markAssistantTurnInterrupted(
  chatId: string,
  messageId: string,
): void {
  const { chatStates } = useChatStore.getState();
  const chatState = chatStates.get(chatId);
  if (!chatState) return;

  const messages = chatState.messages.map((message) =>
    message.id === messageId ? markMessageAsInterrupted(message) : message,
  );
  const newChatStates = new Map(chatStates);
  newChatStates.set(chatId, { ...chatState, messages });
  useChatStore.setState({ chatStates: newChatStates });
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

function assistantTurnSettledOnServer(message: ChatMessage): boolean {
  return message.interrupted !== true;
}

function upgradeAssistantFromServer(
  local: ChatMessage,
  serverMsg: ChatMessage,
): ChatMessage {
  // A local "Interrupted" ghost must not beat a completed server row for the
  // same id — the DB is authoritative once the turn finished.
  if (local.interrupted && assistantTurnSettledOnServer(serverMsg)) {
    return {
      ...serverMsg,
      isStreaming: false,
      streamingContent: undefined,
      streamingReasoning: undefined,
    };
  }

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

/**
 * Match server rows to optimistic locals by content only within the server
 * window. Older paginated turns can repeat the same text; matching them pulls
 * firstConsumedIndex forward and drops the earlier half of the chat below its
 * own latest message.
 */
function findLocalContentDuplicate(
  base: ChatMessage[],
  serverMsg: ChatMessage,
  consumedLocalIds: Set<string>,
  role: "user" | "assistant",
  windowStartIndex: number,
): ChatMessage | undefined {
  for (let i = base.length - 1; i >= windowStartIndex; i--) {
    const localMsg = base[i];
    if (localMsg.role !== role) continue;
    if (consumedLocalIds.has(localMsg.id)) continue;
    if (role === "assistant" && localMsg.isStreaming) continue;
    if (localMsg.content.trim() !== serverMsg.content.trim()) continue;
    if (serverMsg.content.trim().length === 0) continue;
    return localMsg;
  }
  return undefined;
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
  const windowStartIndex = Math.max(0, base.length - serverMessages.length);

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
      const localDup = findLocalContentDuplicate(
        base,
        serverMsg,
        consumedLocalIds,
        "user",
        windowStartIndex,
      );
      if (localDup) {
        merged.push({
          ...localDup,
          id: serverMsg.id,
          ...(serverMsg.attachments?.length && !localDup.attachments?.length
            ? { attachments: serverMsg.attachments }
            : {}),
        });
        consumedLocalIds.add(localDup.id);
        continue;
      }
    }

    if (serverMsg.role === "assistant") {
      const localDup = findLocalContentDuplicate(
        base,
        serverMsg,
        consumedLocalIds,
        "assistant",
        windowStartIndex,
      );
      if (localDup) {
        merged.push(upgradeAssistantFromServer(localDup, serverMsg));
        consumedLocalIds.add(localDup.id);
        continue;
      }
    }

    merged.push(serverMsg);
  }

  // Locals the server list didn't account for. Usually optimistic sends and
  // in-flight placeholders, which belong at the end — but the server list is a
  // *window* (loadMessages asks for the newest N), so once pagination has
  // pulled older turns into the store those fall outside the window too, and
  // appending them would drop the earlier half of the conversation below its
  // own latest message.
  //
  // Position decides which side, not time: server-mapped messages carry no
  // timestamp at all (see mapHistoryMessages). Both lists are chronological, so
  // a leftover sitting before the first message the window claimed is older
  // than the window, and anything after it is newer.
  let firstConsumedIndex = -1;
  for (let i = 0; i < base.length; i++) {
    if (consumedLocalIds.has(base[i].id)) {
      firstConsumedIndex = i;
      break;
    }
  }

  const beforeWindow: ChatMessage[] = [];
  const afterWindow: ChatMessage[] = [];
  base.forEach((localMsg, index) => {
    if (consumedLocalIds.has(localMsg.id)) return;
    // With nothing consumed there is no window to sit outside of, so keep the
    // original append-at-the-end behaviour rather than guessing.
    if (firstConsumedIndex !== -1 && index < firstConsumedIndex) {
      beforeWindow.push(localMsg);
    } else {
      afterWindow.push(localMsg);
    }
  });

  return dedupeChatMessages([...beforeWindow, ...merged, ...afterWindow]);
}

/**
 * True when a live stream is in flight and applying server history would wipe
 * partial UI state. Does NOT treat needsStreamRecovery as blocking — recovery
 * mode needs a server reload to repopulate missing assistant turns.
 */
export function chatHasLiveStreamBlockingHistory(chatId: string): boolean {
  const chatState = useChatStore.getState().chatStates.get(chatId);
  if (!chatState) return false;

  // isSending without a visible isStreaming row is the broken state that drops
  // tool/text updates — still block history reload until the turn finishes.
  if (chatState.isSending) return true;

  const hasActiveRequest =
    activeStreamRequests.has(chatId) || isResumingStream(chatId);

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

/** Resolve chatId when a chunk only carries the gateway stream requestId. */
export function resolveChatIdForStreamRequest(
  requestId: string,
): string | undefined {
  for (const [chatId, activeRequestId] of activeStreamRequests.entries()) {
    if (activeRequestId === requestId) {
      return chatId;
    }
  }
  return undefined;
}

/** True only when a done chunk can finalize UI state (must include chatId). */
export function isStreamDoneChunkWithChatId(
  chunk: Record<string, unknown>,
): boolean {
  return (
    chunk.type === "done" &&
    typeof chunk.chatId === "string" &&
    chunk.chatId.length > 0
  );
}

export function untrackActiveStream(chatId: string): void {
  activeStreamRequests.delete(chatId);
  appliedChunkCounts.delete(chatId);
  clearResumeRetry(chatId);
  cancelSubscribeHandler(chatId);
  // Single disarm point for every path that retires a stream (done, error,
  // user stop, supersede). Disarming at each of the dozen call sites would
  // leave a timer armed the first time a new one is added.
  disarmFirstChunkWatchdog(chatId);
}

/** Resume after provider backoff must start a new stream, not resubscribe to the old lease. */
export function shouldResumeWithFreshGatewayStream(state: {
  streamRecoveryReason?: StreamRecoveryReason;
  lastTurnOutcome?: LastTurnOutcome;
}): boolean {
  return (
    state.streamRecoveryReason === "rateLimit" ||
    state.lastTurnOutcome === "providerRefused"
  );
}

/** Stop the gateway stream and release its concurrency slot without marking a user stop. */
export async function releaseGatewayAgentStream(
  chatId: string,
  options?: {
    onCancelRequest?: (requestId: string) => void;
  },
): Promise<void> {
  const requestId = activeStreamRequests.get(chatId);
  if (requestId && requestId !== RESUME_STREAM_PLACEHOLDER) {
    options?.onCancelRequest?.(requestId);
  }
  untrackActiveStream(chatId);
  await gateway
    .send("agent:stop", { chatId }, { timeoutMs: AGENT_INTERRUPT_TIMEOUT_MS })
    .catch(() => {});
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

    // Clear needsStreamRecovery if nothing to recover.
    //
    // `isStale` means "no stream is in flight on the client", which is not the
    // same as "nothing to recover": a provider refusal retires its stream and
    // then raises this banner, so the banner's whole existence presupposes a
    // stale chat. A reconnect also says nothing about whether the account's
    // quota cleared, and `shouldAutoRetryStreamRecoveryAfterReconnect` already
    // declines to retry a rate-limit banner — so sweeping it here would leave
    // the user with neither an explanation nor an automatic retry.
    if (
      state.needsStreamRecovery &&
      isStale &&
      !recoveryBannerSurvivesStreamEnd({
        needsStreamRecovery: state.needsStreamRecovery,
        reason: state.streamRecoveryReason,
      })
    ) {
      store.setNeedsStreamRecovery(chatId, false);
    }
  }
}

async function recoverAfterReconnect(): Promise<void> {
  startPostReconnectStreamRecoveryWave();
  if (recoverStreamsAfterReconnect) {
    await recoverStreamsAfterReconnect();
  } else {
    await clearStaleConnectionPaused();
  }
}

/** Latest stream chunk handler (useAgent registers; survives tab unmount). */
const agentStreamChunkHandlerRef: {
  current: StreamChunkHandler | null;
} = { current: null };

let agentStreamBroadcastRegistered = false;

export function setAgentStreamChunkHandler(
  handler: StreamChunkHandler | null,
): void {
  agentStreamChunkHandlerRef.current = handler;
}

/** One global listener — ChatContainer mount/unmount must not drop agent chunks. */
export function ensureAgentStreamBroadcastListener(): void {
  if (agentStreamBroadcastRegistered) return;
  agentStreamBroadcastRegistered = true;

  window.addEventListener("gateway-broadcast", (event: Event) => {
    const handler = agentStreamChunkHandlerRef.current;
    if (!handler) return;

    const detail = (event as CustomEvent<{ type: string; data?: unknown }>)
      .detail;
    if (!detail?.type?.startsWith("agent:")) return;

    if (detail.type === "agent:chunk" && detail.data) {
      handler(detail.data as StreamChunk);
    } else if (detail.type === "agent:complete" && detail.data) {
      const data = detail.data as Record<string, unknown>;
      const chatId = data.chatId as string | undefined;
      if (chatId) {
        handler({
          type: "done",
          chatId,
          payload: { finalMessage: data.finalMessage },
        } as StreamChunk);
      }
    } else if (detail.type === "agent:error" && detail.data) {
      const data = detail.data as Record<string, unknown>;
      const chatId = data.chatId as string | undefined;
      const error = data.error as string | undefined;
      if (chatId && error && isExpectedStreamCancellation(error)) {
        return;
      }
      if (chatId) {
        handler({
          type: "error",
          chatId,
          payload: { error: error || "Stream error" },
        } as StreamChunk);
      }
    }
  });
}

export function ensureGatewayRecoveryRegistered(): void {
  if (gatewayRecoveryRegistered) return;
  gatewayRecoveryRegistered = true;

  ensureAgentStreamBroadcastListener();

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

export const MAX_AUTO_CONTINUE_ATTEMPTS = 3;

/** Attempts keyed by visible user turn id (resets when the user sends a new message). */
const autoContinueAttemptsByTurn = new Map<string, number>();

function autoContinueTurnKey(chatId: string, turnId: string): string {
  return `${chatId}:${turnId}`;
}

/** Last visible (non-hidden-continue) user message — scopes auto-continue retries. */
export function findLastVisibleUserMessage(
  messages: ChatMessage[],
): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (isHiddenContinueUserMessage(message.content)) continue;
    return message;
  }
  return undefined;
}

export function assistantMessageWasStopped(message: ChatMessage): boolean {
  if (!message.sequence) return false;
  return message.sequence.some(
    (item) =>
      item.type === "tool" &&
      ((item.data as { status?: string; error?: string }).status === "stopped" ||
        (item.data as { error?: string }).error === "Stopped by user"),
  );
}

export function resetAutoContinueAttempts(chatId: string): void {
  for (const key of autoContinueAttemptsByTurn.keys()) {
    if (key.startsWith(`${chatId}:`)) {
      autoContinueAttemptsByTurn.delete(key);
    }
  }
}

export function getAutoContinueAttempts(
  chatId: string,
  messages: ChatMessage[],
): number {
  const turn = findLastVisibleUserMessage(messages);
  if (!turn) return 0;
  return autoContinueAttemptsByTurn.get(autoContinueTurnKey(chatId, turn.id)) ?? 0;
}

export function recordAutoContinueAttempt(
  chatId: string,
  messages: ChatMessage[],
): number {
  const turn = findLastVisibleUserMessage(messages);
  if (!turn) return 0;
  const key = autoContinueTurnKey(chatId, turn.id);
  const next = (autoContinueAttemptsByTurn.get(key) ?? 0) + 1;
  autoContinueAttemptsByTurn.set(key, next);
  return next;
}

export type AutoContinueBlockReason =
  | "isSending"
  | "gatewayNotReady"
  | "resumingStream"
  | "turnComplete"
  | "providerRefused"
  | "userStopped"
  | "awaitingStreamResubscribe"
  | "maxAttempts";

/** Why auto-continue did not run — for logs and support. */
export function getAutoContinueBlockReason(args: {
  chatId: string;
  messages: ChatMessage[];
  isSending: boolean;
  connectionPaused: boolean;
  needsStreamRecovery: boolean;
  streamRecoveryReason?: StreamRecoveryReason;
  lastTurnOutcome?: LastTurnOutcome;
  gatewayReady: boolean;
}): AutoContinueBlockReason | null {
  if (args.isSending) return "isSending";
  if (isResumingStream(args.chatId)) return "resumingStream";

  // Above the turn-state tests, because a refusal produces no assistant message
  // at all: `assistantMessageWasStopped` below has nothing to inspect, and the
  // turn reads as merely interrupted. Retrying it sends another full context at
  // an account the provider has already told us is at its ceiling.
  if (args.lastTurnOutcome === "providerRefused") return "providerRefused";
  if (args.lastTurnOutcome === "userStopped") return "userStopped";

  // The rule `shouldAutoRetryStreamRecoveryAfterReconnect` has always applied,
  // kept here as well because a live rate-limit banner is sufficient evidence
  // on its own — `lastTurnOutcome` is set at the raise sites and this is not.
  if (args.needsStreamRecovery && args.streamRecoveryReason === "rateLimit") {
    return "providerRefused";
  }

  const lastAssistant = [...args.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!lastAssistant?.interrupted) {
    if (!lastUserTurnNeedsContinue(args.messages)) return "turnComplete";
    const lastUser = findLastVisibleUserMessage(args.messages);
    if (!lastUser) return "turnComplete";
    const lastUserIndex = args.messages.findIndex((m) => m.id === lastUser.id);
    const hasAssistantForTurn = args.messages
      .slice(lastUserIndex + 1)
      .some((m) => m.role === "assistant");
    if (hasAssistantForTurn) return "turnComplete";
  } else if (assistantMessageWasStopped(lastAssistant)) {
    return "userStopped";
  }

  // Deliberately below the turn-state checks. Whether auto-continue runs is
  // unaffected by the order — only which reason is reported when several apply
  // — and a finished turn is finished whether or not the gateway is ready.
  // Reporting readiness for it sent people looking at a healthy gateway.
  if (!args.gatewayReady) return "gatewayNotReady";

  if (args.connectionPaused && activeStreamRequests.has(args.chatId)) {
    return "awaitingStreamResubscribe";
  }

  if (
    getAutoContinueAttempts(args.chatId, args.messages) >=
    MAX_AUTO_CONTINUE_ATTEMPTS
  ) {
    return "maxAttempts";
  }

  return null;
}

/** True when the UI shows "Interrupted" and we should auto-send a hidden continue. */
export function shouldAutoContinueInterruptedTurn(args: {
  chatId: string;
  messages: ChatMessage[];
  isSending: boolean;
  connectionPaused: boolean;
  needsStreamRecovery: boolean;
  streamRecoveryReason?: StreamRecoveryReason;
  lastTurnOutcome?: LastTurnOutcome;
  gatewayReady: boolean;
}): boolean {
  return getAutoContinueBlockReason(args) === null;
}

const postReconnectStreamRecoveryAttempted = new Set<string>();

/** Cleared at the start of each gateway reconnect recovery wave. */
export function startPostReconnectStreamRecoveryWave(): void {
  postReconnectStreamRecoveryAttempted.clear();
}

export function resetPostReconnectStreamRecoveryForTests(): void {
  postReconnectStreamRecoveryAttempted.clear();
}

export function markPostReconnectStreamRecoveryAttempted(chatId: string): void {
  postReconnectStreamRecoveryAttempted.add(chatId);
}

/** Chats that showed "Continue" after subscribe retries exhausted — retry once per reconnect. */
export function shouldAutoRetryStreamRecoveryAfterReconnect(args: {
  chatId: string;
  needsStreamRecovery: boolean;
  streamRecoveryReason?: string;
  isSending: boolean;
}): boolean {
  if (postReconnectStreamRecoveryAttempted.has(args.chatId)) {
    return false;
  }
  if (!args.needsStreamRecovery) return false;
  if (args.streamRecoveryReason === "rateLimit") return false;
  if (args.isSending) return false;
  if (activeStreamRequests.has(args.chatId)) return false;
  return true;
}

export function listChatsForPostReconnectStreamRecovery(): string[] {
  const store = useChatStore.getState();
  const chatIds: string[] = [];
  for (const [chatId, state] of store.chatStates.entries()) {
    if (
      shouldAutoRetryStreamRecoveryAfterReconnect({
        chatId,
        needsStreamRecovery: state.needsStreamRecovery ?? false,
        streamRecoveryReason: state.streamRecoveryReason,
        isSending: state.isSending ?? false,
      })
    ) {
      chatIds.push(chatId);
    }
  }
  return chatIds;
}
