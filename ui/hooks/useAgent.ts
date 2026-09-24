/**
 * useAgent Hook - Manage agent streaming and messages
 * Handles real-time streaming from the AI agent via WebSocket
 */

import { useCallback, useEffect, useRef } from "react";
import {
  isInterruptedToolResult,
  resolveToolCallStatus,
} from "../../src/core/utils/interruptedToolResult";
import { isExpectedStreamCancellation, isRecoverableProviderStreamDrop } from "../../src/core/constants/streamCancellation.js";
import type { AgentConfig, StreamChunk } from "../types/core";
import type {
  MessageAttachment,
  ChatMessage,
  SequenceItem,
} from "../types/chat";
import { useChatStore } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";
import { useProviderAuthStore } from "../stores/providerAuthStore";
import {
  isProviderAuthRejection,
  providerForModelId,
} from "../utils/providerAuthRejection";
import { gateway, GATEWAY_DISCONNECTED_ERROR } from "../src/lib/gateway";
import { fetchChatHistory } from "../utils/chatHistoryApi";
import { mapHistoryMessages } from "../utils/historyMapper";
import { resolveAgentFocusContext } from "../utils/agentFocusContext";
import {
  AGENT_INTERRUPT_TIMEOUT_MS,
  isSendGenerationCurrent,
  nextSendGeneration,
} from "../utils/agentSendLifecycle";
import { isAppTabMergedWithChat, isPlatformTabMergedWithChat } from "../utils/appTabMerge";
import { openPlatformBrowserTab } from "../lib/openPlatformBrowserTab";
import { recoveryBannerSurvivesStreamEnd } from "../lib/streamRecoveryPersistence";
import {
  isAppAutoOpenToolName,
  isUserOnChatTab,
  resolveAppIdForAutoOpen,
  shouldAutoOpenArtifactTab,
} from "../utils/resolveAppIdForAutoOpen";
import { buildRecoveryAgentConfigForChat } from "../utils/buildRecoveryAgentConfig";
import { scheduleChatTitleGeneration } from "../lib/scheduleChatTitle";
import {
  activeStreamRequests,
  appliedChunkCounts,
  chatIsStreamingOnServer,
  cancelSubscribeHandler,
  clearResumeRetry,
  clearStalePausedChats,
  ensureGatewayRecoveryRegistered,
  setAgentStreamChunkHandler,
  ensureTrackedStream,
  finalizeStreamingMessages,
  HIDDEN_CONTINUE_USER_MESSAGE,
  interruptedTurnNeedsContinue,
  isHiddenContinueUserMessage,
  isResumingStream,
  lastUserTurnNeedsContinue,
  recordAutoContinueAttempt,
  resetAutoContinueAttempts,
  markAssistantTurnInterrupted,
  shouldAutoContinueInterruptedTurn,
  listChatsForPostReconnectStreamRecovery,
  markPostReconnectStreamRecoveryAttempted,
  shouldIgnoreDuplicateDoneChunk,
  resolveChatIdForStreamRequest,
  markResuming,
  releaseGatewayAgentStream,
  shouldResumeWithFreshGatewayStream,
  mergeHistoryWithLocal,
  ensureStreamingAssistantMessageRow,
  rehydrateStreamingRefsForChat,
  scheduleStreamResumeRetry,
  serverHasCompletedAssistantForStreamingTurn,
  setRecoverStreamsHandler,
  subscribeWithRetry,
  trackActiveStream,
  untrackActiveStream,
} from "../lib/agentStreamRecovery";
import {
  armFirstChunkWatchdog,
  FIRST_CHUNK_STALL_CANCEL_REASON,
  noteStreamChunkArrived,
  type FirstChunkStall,
} from "../lib/agentFirstChunkWatchdog";
import {
  getAgentStreamingRefs,
  resetAgentStreamingRefsForChat,
} from "../lib/agentStreamingRefs";
import type { ToolCall } from "../types/core";
import {
  finishUiStreamProfiler,
  getUiStreamProfiler,
  startUiStreamProfiler,
} from "../lib/streamProfiler";

const RATE_LIMIT_EXHAUSTED_ERROR_CODE = "rate_limit_exhausted";
/**
 * A limit that will not clear by waiting, so this deliberately does not reach
 * for the Resume UI. Offering Resume for a spend cap that lifts in three weeks
 * invites the user to keep pressing a button that cannot work.
 */
const PROVIDER_QUOTA_EXHAUSTED_ERROR_CODE = "provider_quota_exhausted";
const RATE_LIMIT_WAIT_TEXT_PATTERN =
  /\n\n_Rate limited — waiting \d+s before retrying…_\n\n/g;

function isRateLimitWaitDelta(text: string): boolean {
  return (
    text.includes("Rate limited — waiting") &&
    text.includes("before retrying")
  );
}

function stripRateLimitWaitDeltas(text: string): string {
  return text.replace(RATE_LIMIT_WAIT_TEXT_PATTERN, "");
}

export function useAgent() {
  const addMessage = useChatStore((s) => s.addMessage);
  const updateStreamingMessage = useChatStore((s) => s.updateStreamingMessage);
  const finalizeStreamingMessage = useChatStore((s) => s.finalizeStreamingMessage);
  const setSending = useChatStore((s) => s.setSending);
  const setWaitingForAgentSlot = useChatStore((s) => s.setWaitingForAgentSlot);
  const setConnectionPaused = useChatStore((s) => s.setConnectionPaused);
  const setFinishingWork = useChatStore((s) => s.setFinishingWork);
  const setNeedsStreamRecovery = useChatStore((s) => s.setNeedsStreamRecovery);
  const setLastTurnOutcome = useChatStore((s) => s.setLastTurnOutcome);
  const setError = useChatStore((s) => s.setError);
  
  // Streaming state management functions
  const initStreamingState = useChatStore((s) => s.initStreamingState);
  const reactivateAssistantMessage = useChatStore(
    (s) => s.reactivateAssistantMessage,
  );
  const setStreamingText = useChatStore((s) => s.setStreamingText);
  const setStreamingReasoning = useChatStore((s) => s.setStreamingReasoning);
  const replaceStreamingSequence = useChatStore((s) => s.replaceStreamingSequence);
  const upsertStreamingToolCall = useChatStore((s) => s.upsertStreamingToolCall);
  const flushStreamingState = useChatStore((s) => s.flushStreamingState);
  const clearStreamingState = useChatStore((s) => s.clearStreamingState);

  const streamingRefs = getAgentStreamingRefs();
  const streamingMessageIdRef = streamingRefs.streamingMessageIdRef;
  const streamingContentRef = streamingRefs.streamingContentRef;
  const streamingReasoningRef = streamingRefs.streamingReasoningRef;
  const toolCallsMapRef = streamingRefs.toolCallsMapRef;
  const sequenceRef = streamingRefs.sequenceRef;
  const currentTextSegmentRef = streamingRefs.currentTextSegmentRef;

  const updateBatchRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const reasoningBatchRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  /** Request IDs whose chunks should be ignored after interrupt/stop */
  const rejectedRequestIdsRef = useRef<Set<string>>(new Set());
  /** Serialize sendMessage per chat so interrupt + new stream don't overlap */
  const sendMessageLockRef = useRef<Map<string, Promise<void>>>(new Map());
  /** Invalidates cleanup from preempted / superseded sendMessage runs */
  const sendGenerationRef = useRef<Map<string, number>>(new Map());

  // Listen for Gateway connection changes — populated after handleStreamChunk
  const handleStreamChunkRef = useRef<
    (chunk: StreamChunk) => void
  >(() => {});

  /**
   * Terminal chat state for every `done` path, settled in one place.
   *
   * The `done` arm has four exits — duplicate done, stale done, backend
   * finalMessage with no local stream data, and full finalization — and each
   * repeated this sequence. Three of them dropped the recovery banner
   * unconditionally, so a provider refusal (which raises the banner
   * milliseconds before `done` arrives, and produces no local stream data of
   * its own) had its only explanation erased on the way out.
   */
  const settleChatAfterStreamEnd = useCallback(
    (chatId: string) => {
      // Read before the clears: setConnectionPaused(false) drops
      // needsStreamRecovery as a side effect, so a read taken afterwards
      // always sees false and the survival check can never fire.
      const banner = useChatStore.getState().chatStates.get(chatId);
      const keepRecoveryBanner = recoveryBannerSurvivesStreamEnd({
        needsStreamRecovery: banner?.needsStreamRecovery ?? false,
        reason: banner?.streamRecoveryReason,
      });

      setSending(chatId, false);
      setConnectionPaused(chatId, false);
      setFinishingWork(chatId, false);
      if (keepRecoveryBanner) {
        // Re-asserted rather than left alone: setConnectionPaused above has
        // already cleared it, so the reason and the provider's own sentence
        // have to be put back for the banner to render.
        setNeedsStreamRecovery(
          chatId,
          true,
          banner?.streamRecoveryReason,
          banner?.streamRecoveryDetail,
        );
      } else {
        setNeedsStreamRecovery(chatId, false);
      }
    },
    [
      setConnectionPaused,
      setFinishingWork,
      setNeedsStreamRecovery,
      setSending,
    ],
  );

  // Handle streaming chunks
  const handleStreamChunk = useCallback(
    (chunk: StreamChunk) => {
      console.log("[useAgent] handleStreamChunk received:", chunk.type, chunk);

      // Extract chatId from chunk (all chunks should have this)
      const streamChunk = chunk as unknown as Record<string, unknown>;
      const requestId =
        typeof streamChunk.requestId === "string"
          ? streamChunk.requestId
          : undefined;
      let chatId =
        typeof streamChunk.chatId === "string" && streamChunk.chatId.length > 0
          ? streamChunk.chatId
          : undefined;
      if (!chatId && requestId) {
        chatId = resolveChatIdForStreamRequest(requestId);
      }

      if (!chatId) {
        console.error("[useAgent] Chunk missing chatId:", chunk);
        return;
      }

      getUiStreamProfiler(chatId)?.mark(`ui.chunk.received.${chunk.type}`);

      // Sub-agent trigger responses: only hide delegation chat messages, NOT main chat messages
      // When sub-agent asks main agent a question, main agent may respond in BOTH:
      // 1. Delegation chat (delegation:xxx) - hide these from main UI
      // 2. Main chat (user's chat) - SHOW these! Main agent asking user for help
      if (
        streamChunk.isSubAgentTrigger === true &&
        chatId.startsWith("delegation:")
      ) {
        return;
      }

      if (requestId) {
        if (rejectedRequestIdsRef.current.has(requestId)) {
          console.log(
            `[useAgent] Ignoring rejected chunk for ${chatId} (${requestId})`,
          );
          return;
        }
        const activeRequestId =
          activeStreamRequests.get(chatId);
        if (activeRequestId && activeRequestId !== requestId) {
          console.log(
            `[useAgent] Ignoring stale chunk for ${chatId} (active=${activeRequestId}, got=${requestId})`,
          );
          return;
        }
      }

      // The turn is reaching us. Retire the first-chunk watchdog permanently —
      // placed after the filters above so a stale or rejected chunk cannot
      // vouch for a stream that is still silent.
      noteStreamChunkArrived(chatId, requestId);

      // Ensure we have a streaming message for all chunk types
      rehydrateStreamingRefsForChat(chatId, streamingRefs);
      const boundStreamingId = streamingMessageIdRef.current.get(chatId);
      if (boundStreamingId) {
        ensureStreamingAssistantMessageRow(
          chatId,
          boundStreamingId,
          streamingRefs,
        );
      }
      if (
        !streamingMessageIdRef.current.has(chatId) &&
        chunk.type !== "stream-start" &&
        chunk.type !== "done" &&
        chunk.type !== "error" &&
        chunk.type !== "start-step" &&
        chunk.type !== "step-usage" &&
        chunk.type !== "concurrency-queued" &&
        chunk.type !== "concurrency-acquired"
      ) {
        const messageId = `msg-${Date.now()}`;
        streamingMessageIdRef.current.set(chatId, messageId);
        streamingContentRef.current.set(chatId, "");
        streamingReasoningRef.current.set(chatId, "");
        toolCallsMapRef.current.set(chatId, new Map());
        sequenceRef.current.set(chatId, []); // Initialize sequence
        currentTextSegmentRef.current.set(chatId, ""); // Initialize text segment

        addMessage(
          {
            id: messageId,
            role: "assistant",
            content: "",
            isStreaming: true,
            streamingContent: "",
            reasoning: "",
            streamingReasoning: "",
            toolCalls: [],
            sequence: [], // Initialize empty sequence
          },
          chatId,
        );
        initStreamingState(chatId, messageId);
      }

      switch (chunk.type) {
        case "stream-start": {
          const messageId = (
            chunk.payload as { messageId?: string }
          ).messageId?.trim();
          if (!messageId) break;

          const uiProfiler = getUiStreamProfiler(chatId);
          const existingId = streamingMessageIdRef.current.get(chatId);
          const chatState = useChatStore.getState().chatStates.get(chatId);
          const existingRow = chatState?.messages.find((m) => m.id === messageId);

          uiProfiler?.measureSync("ui.streamStart.handler", () => {
            if (existingId === messageId) {
              if (existingRow?.interrupted) {
                reactivateAssistantMessage(chatId, messageId);
              } else if (!existingRow) {
                ensureStreamingAssistantMessageRow(
                  chatId,
                  messageId,
                  streamingRefs,
                );
              }
              return;
            }

            if (existingId) {
              const { chatStates } = useChatStore.getState();
              const stateForRename = chatStates.get(chatId);
              if (stateForRename) {
                const updatedMessages = stateForRename.messages.map((msg) =>
                  msg.id === existingId ? { ...msg, id: messageId } : msg,
                );
                const newChatStates = new Map(chatStates);
                newChatStates.set(chatId, {
                  ...stateForRename,
                  messages: updatedMessages,
                });
                useChatStore.setState({ chatStates: newChatStates });
              }
            } else if (existingRow) {
              reactivateAssistantMessage(chatId, messageId);
            } else {
              streamingMessageIdRef.current.set(chatId, messageId);
              streamingContentRef.current.set(chatId, "");
              streamingReasoningRef.current.set(chatId, "");
              toolCallsMapRef.current.set(chatId, new Map());
              sequenceRef.current.set(chatId, []);
              currentTextSegmentRef.current.set(chatId, "");

              addMessage(
                {
                  id: messageId,
                  role: "assistant",
                  content: "",
                  isStreaming: true,
                  streamingContent: "",
                  reasoning: "",
                  streamingReasoning: "",
                  toolCalls: [],
                  sequence: [],
                },
                chatId,
              );
              initStreamingState(chatId, messageId);
            }
          });

          streamingMessageIdRef.current.set(chatId, messageId);
          const reactivated = useChatStore.getState().chatStates.get(chatId)
            ?.messages.find((m) => m.id === messageId);
          streamingContentRef.current.set(
            chatId,
            reactivated?.streamingContent ?? reactivated?.content ?? "",
          );
          streamingReasoningRef.current.set(
            chatId,
            reactivated?.streamingReasoning ?? reactivated?.reasoning ?? "",
          );
          if (reactivated?.sequence?.length) {
            sequenceRef.current.set(chatId, reactivated.sequence as SequenceItem[]);
          }
          if (reactivated?.toolCalls?.length) {
            const map = new Map<string, ToolCall>();
            for (const tc of reactivated.toolCalls) {
              map.set(tc.id, tc);
            }
            toolCallsMapRef.current.set(chatId, map);
          }
          break;
        }

        case "concurrency-queued":
          setWaitingForAgentSlot(chatId, true);
          break;

        case "concurrency-acquired":
          setWaitingForAgentSlot(chatId, false);
          break;

        case "reasoning-delta":
          {
            // Append reasoning delta to ref (always immediate)
            const text = (chunk.payload as { text: string }).text || "";
            const currentReasoning =
              streamingReasoningRef.current.get(chatId) || "";
            streamingReasoningRef.current.set(chatId, currentReasoning + text);

            // Batch reasoning state updates to avoid excessive re-renders (50ms, same as text-delta)
            const existingReasoningTimeout = reasoningBatchRef.current.get(chatId);
            if (existingReasoningTimeout) {
              clearTimeout(existingReasoningTimeout);
            }
            const reasoningTimeout = setTimeout(() => {
              const { chatStates } = useChatStore.getState();
              const chatState = chatStates.get(chatId);
              const streamingMessageId =
                streamingMessageIdRef.current.get(chatId);
              if (chatState && streamingMessageId) {
                const updatedMessages = chatState.messages.map((msg) =>
                  msg.id === streamingMessageId
                    ? {
                        ...msg,
                        streamingReasoning:
                          streamingReasoningRef.current.get(chatId) || "",
                      }
                    : msg,
                );
                const newChatStates = new Map(chatStates);
                newChatStates.set(chatId, {
                  ...chatState,
                  messages: updatedMessages,
                });
                useChatStore.setState({ chatStates: newChatStates });
                // Mirror into streaming slice
                setStreamingReasoning(
                  chatId,
                  streamingReasoningRef.current.get(chatId) || "",
                );
              }
              reasoningBatchRef.current.delete(chatId);
            }, 50); // Update at most every 50ms (20 FPS)
            reasoningBatchRef.current.set(chatId, reasoningTimeout);
          }
          break;

        case "tool-call":
          {
            const pendingTextBatch = updateBatchRef.current.get(chatId);
            if (pendingTextBatch) {
              clearTimeout(pendingTextBatch);
              updateBatchRef.current.delete(chatId);
              const flushMessageId =
                streamingMessageIdRef.current.get(chatId);
              const flushContent =
                streamingContentRef.current.get(chatId);
              if (flushMessageId && flushContent !== undefined) {
                updateStreamingMessage(flushMessageId, flushContent, chatId);
              }
            }

            // Add or update tool call
            const payload = chunk.payload as {
              toolName: string;
              args?: Record<string, unknown>;
              toolCallId?: string;
            };
            // OpenAI requires tool call IDs to be max 64 characters
            const fallbackId = `tool-${Date.now()}-${payload.toolName}`;
            const toolCallId = payload.toolCallId || 
              (fallbackId.length > 64 ? fallbackId.substring(0, 64) : fallbackId);

            console.log(
              `[useAgent] Tool call: ${payload.toolName}`,
              payload.args,
            );

            const chatToolCalls =
              toolCallsMapRef.current.get(chatId) || new Map();
            chatToolCalls.set(toolCallId, {
              id: toolCallId,
              toolName: payload.toolName,
              args: payload.args,
              status: "calling",
            });
            toolCallsMapRef.current.set(chatId, chatToolCalls);

            // ✅ SEQUENCE: Flush accumulated text before tool
            const currentSegment =
              currentTextSegmentRef.current.get(chatId) || "";
            const sequence = sequenceRef.current.get(chatId) || [];

            if (currentSegment.trim()) {
              console.log(
                `[useAgent] Adding text to sequence: "${currentSegment.trim().substring(0, 50)}..."`,
              );
              sequence.push({ type: "text", data: currentSegment.trim() });
              currentTextSegmentRef.current.set(chatId, ""); // Reset

              // Clear streamingTrailingText now that the segment has been
              // flushed into sequence. Without this, the just-flushed text
              // stays mirrored on the message and gets re-rendered AGAIN
              // outside the working card as `finalTextAfterAllTools` —
              // showing the same text twice (once between tools inside the
              // card, once after the card).
              const sId = streamingMessageIdRef.current.get(chatId);
              if (sId) {
                const { chatStates } = useChatStore.getState();
                const cs = chatStates.get(chatId);
                if (cs) {
                  const updated = cs.messages.map((m) =>
                    m.id === sId
                      ? { ...m, streamingTrailingText: undefined }
                      : m,
                  );
                  const next = new Map(chatStates);
                  next.set(chatId, { ...cs, messages: updated });
                  useChatStore.setState({ chatStates: next });
                }
              }
            }

            // Add tool to sequence with 'calling' status
            console.log(
              `[useAgent] Adding tool to sequence: ${payload.toolName}`,
            );
            sequence.push({
              type: "tool",
              data: {
                name: payload.toolName,
                input: payload.args,
                status: "calling",
                toolCallId, // Track ID for updating later
              },
            });
            sequenceRef.current.set(chatId, sequence);

            // Update the message with new tool calls AND sequence directly in chatState
            const { chatStates } = useChatStore.getState();
            const chatState = chatStates.get(chatId);
            const streamingMessageId =
              streamingMessageIdRef.current.get(chatId);
            if (chatState && streamingMessageId) {
              const toolCallsArray = Array.from(chatToolCalls.values());
              console.log(
                `[useAgent] Updating UI with ${toolCallsArray.length} tool call(s) and ${sequence.length} sequence items`,
              );

              const updatedMessages = chatState.messages.map((msg) =>
                msg.id === streamingMessageId
                  ? {
                      ...msg,
                      toolCalls: toolCallsArray,
                      sequence: [...sequence], // Update sequence in real-time
                    }
                  : msg,
              );
              const newChatStates = new Map(chatStates);
              newChatStates.set(chatId, {
                ...chatState,
                messages: updatedMessages,
              });
              useChatStore.setState({ chatStates: newChatStates });

              // Mirror into streaming slice (granular tool subscription)
              upsertStreamingToolCall(chatId, {
                id: toolCallId,
                toolName: payload.toolName,
                args: payload.args,
                status: "calling",
              });
              replaceStreamingSequence(chatId, [...sequence]);
            }
          }
          break;

        case "tool-result":
          {
            // Update tool call with result
            const payload = chunk.payload as {
              toolCallId: string;
              result?: unknown;
              error?: string;
            };
            const chatToolCalls = toolCallsMapRef.current.get(chatId);
            const existingCall = chatToolCalls?.get(payload.toolCallId);
            const toolStatus = resolveToolCallStatus({
              hasError: !!payload.error,
              result: payload.result,
            });
            const displayResult =
              toolStatus === "interrupted" ||
              isInterruptedToolResult(payload.result)
                ? undefined
                : payload.result;

            console.log(
              `[useAgent] Tool result for ${existingCall?.toolName || payload.toolCallId}:`,
              displayResult
                ? typeof displayResult === "string"
                  ? displayResult.substring(0, 100)
                  : JSON.stringify(displayResult).substring(0, 100)
                : toolStatus === "interrupted"
                  ? "interrupted"
                  : "no result",
            );

            if (existingCall && chatToolCalls) {
              chatToolCalls.set(payload.toolCallId, {
                ...existingCall,
                status: toolStatus,
                result:
                  typeof displayResult === "string"
                    ? displayResult
                    : displayResult !== undefined
                      ? JSON.stringify(displayResult)
                      : undefined,
                error: payload.error,
              });
              toolCallsMapRef.current.set(chatId, chatToolCalls);

              // ✅ SEQUENCE: Update tool in sequence with result
              const sequence = sequenceRef.current.get(chatId) || [];
              const toolIndex = sequence.findIndex(
                (item) =>
                  item.type === "tool" &&
                  (item.data as { toolCallId?: string }).toolCallId ===
                    payload.toolCallId,
              );

              if (toolIndex !== -1) {
                console.log(
                  `[useAgent] Updating tool in sequence at index ${toolIndex} with result`,
                );
                sequence[toolIndex].data = {
                  name: existingCall.toolName,
                  input: existingCall.args,
                  output: displayResult,
                  status: toolStatus,
                  toolCallId: payload.toolCallId, // Preserve so sequence stays identifiable
                };
                sequenceRef.current.set(chatId, sequence);
              } else {
                // Fallback: toolCallId not found in sequence (e.g. mismatch) — add a completed entry
                console.warn(
                  `[useAgent] Could not find sequence entry for toolCallId ${payload.toolCallId}, appending completed entry`,
                );
                sequence.push({
                  type: "tool",
                  data: {
                    name: existingCall.toolName,
                    input: existingCall.args,
                    output: displayResult,
                    status: toolStatus,
                    toolCallId: payload.toolCallId,
                  },
                });
                sequenceRef.current.set(chatId, sequence);
              }

              // Update the message directly in chatState
              const { chatStates } = useChatStore.getState();
              const chatState = chatStates.get(chatId);
              const streamingMessageId =
                streamingMessageIdRef.current.get(chatId);
              if (chatState && streamingMessageId) {
                const toolCallsArray = Array.from(chatToolCalls.values());
                console.log(
                  `[useAgent] Updating UI after tool result, ${toolCallsArray.length} tool call(s):`,
                  toolCallsArray.map((tc) => ({
                    name: tc.toolName,
                    status: tc.status,
                  })),
                );

                const updatedMessages = chatState.messages.map((msg) =>
                  msg.id === streamingMessageId
                    ? {
                        ...msg,
                        toolCalls: toolCallsArray,
                        sequence: [...sequence], // Update sequence with tool result
                      }
                    : msg,
                );
                const newChatStates = new Map(chatStates);
                newChatStates.set(chatId, {
                  ...chatState,
                  messages: updatedMessages,
                });
                useChatStore.setState({ chatStates: newChatStates });

                // Mirror into streaming slice
                const updatedToolCall = chatToolCalls.get(payload.toolCallId);
                if (updatedToolCall) {
                  upsertStreamingToolCall(chatId, {
                    id: payload.toolCallId,
                    toolName: updatedToolCall.toolName,
                    args: updatedToolCall.args,
                    status: updatedToolCall.status,
                    result: updatedToolCall.result,
                    error: updatedToolCall.error,
                  });
                }
                replaceStreamingSequence(chatId, [...sequence]);
              }

              // === Auto-open document/app tabs when agent creates or edits them ===
              const parsedResultForAutoOpen = (() => {
                try {
                  const raw =
                    typeof payload.result === "string"
                      ? JSON.parse(payload.result)
                      : payload.result;
                  return raw && typeof raw === "object"
                    ? (raw as Record<string, unknown>)
                    : null;
                } catch {
                  return null;
                }
              })();

              if (
                shouldAutoOpenArtifactTab({
                  toolName: existingCall.toolName,
                  hasError: !!payload.error,
                  hasResult: !!payload.result,
                  parsedResult: parsedResultForAutoOpen,
                  args: existingCall.args,
                })
              ) {
                try {
                  const parsedResult = parsedResultForAutoOpen;

                  let docId: string | undefined;
                  let docTitle: string | undefined;
                  let isApp = false;

                  if (
                    existingCall.toolName === "create_document" ||
                    existingCall.toolName === "import_document"
                  ) {
                    const docData = parsedResult?.data ?? parsedResult;
                    docId = docData?.id as string | undefined;
                    docTitle = (docData?.title as string) || "Document";
                  } else if (isAppAutoOpenToolName(existingCall.toolName)) {
                    docId = resolveAppIdForAutoOpen({
                      toolName: existingCall.toolName,
                      args: existingCall.args,
                      parsedResult,
                    });
                    isApp = true;

                    const docData =
                      parsedResult?.data && typeof parsedResult.data === "object"
                        ? (parsedResult.data as Record<string, unknown>)
                        : undefined;
                    const existingAppTab = docId
                      ? useTabStore.getState().getTab(`app-${docId}`)
                      : undefined;
                    docTitle =
                      existingAppTab?.title ||
                      (typeof docData?.title === "string" && docData.title.length > 0
                        ? docData.title
                        : undefined) ||
                      "App";

                    console.log("[useAgent] app auto-open:", {
                      toolName: existingCall.toolName,
                      appId: docId,
                      args: existingCall.args,
                    });
                  }

                  if (docId) {
                    const tabType = isApp ? "app" : "document";
                    const { createTab, createArtifactFromChat, getTab, activeTabId } =
                      useTabStore.getState();

                    console.log("[useAgent] Attempting auto-open:", {
                      docId,
                      tabType,
                    });

                    // Check if tab already exists
                    const existingTabId = `${tabType}-${docId}`;
                    const existingTab = getTab(existingTabId);
                    const chatTabId = `chat-${chatId}`;

                    const autoSwitch = isUserOnChatTab(
                      chatTabId,
                      activeTabId,
                      getTab,
                    );

                    if (
                      existingTab &&
                      isApp &&
                      isAppTabMergedWithChat(chatTabId, existingTabId)
                    ) {
                      console.log(
                        `[useAgent] App tab already merged with chat, skipping re-open: ${existingTabId}`,
                      );
                    } else if (existingTab) {
                      createArtifactFromChat(chatTabId, existingTabId, {
                        autoSwitch,
                      });
                      console.log(
                        `[useAgent] Refreshed existing ${tabType} tab: ${existingTabId}, autoSwitch: ${autoSwitch}`,
                      );
                    } else {
                      // Create new tab and merge
                      const artifactTabId = createTab(
                        tabType,
                        docId,
                        docTitle || "Artifact",
                      );
                      createArtifactFromChat(chatTabId, artifactTabId, { autoSwitch });
                      console.log(
                        `[useAgent] Auto-opened ${tabType} tab: ${artifactTabId} merged with ${chatTabId}, autoSwitch: ${autoSwitch}`,
                      );

                      // If title is a placeholder, resolve actual app title from gateway
                      if (isApp && docId && (docTitle === "App" || docTitle === "Artifact")) {
                        void gateway
                          .send("app:list", {})
                          .then((appsResponse) => {
                            const apps = appsResponse?.data as Array<{ id: string; title: string }> | undefined;
                            const appInfo = apps?.find((a) => a.id === docId);
                            if (appInfo?.title) {
                              useTabStore.getState().updateTabTitle(artifactTabId, appInfo.title);
                            }
                          })
                          .catch(() => {});
                      }
                    }
                  } else {
                    console.warn("[useAgent] No docId found for auto-open:", {
                      toolName: existingCall.toolName,
                      args: existingCall.args,
                      result: payload.result,
                    });
                  }
                } catch (parseErr) {
                  console.warn(
                    "[useAgent] Could not parse tool result for auto-open:",
                    parseErr,
                  );
                }
              }

              // Merge platform browser beside chat when prepare_browser succeeds (embedded tab only)
              if (
                existingCall.toolName === "connect_platform" &&
                (existingCall.args as Record<string, unknown> | undefined)
                  ?.action === "prepare_browser" &&
                !payload.error &&
                parsedResultForAutoOpen?.success !== false &&
                parsedResultForAutoOpen?.data?.browserMode !== "real_chrome"
              ) {
                try {
                  const platformArg = (
                    existingCall.args as Record<string, unknown> | undefined
                  )?.platform;
                  const platformId =
                    typeof platformArg === "string" && platformArg.trim().length > 0
                      ? platformArg.trim()
                      : "linkedin";
                  const chatTabId = `chat-${chatId}`;
                  const { activeTabId, getTab, switchToTab } =
                    useTabStore.getState();
                  const platformTabId = `platform-${platformId}`;
                  const autoSwitch = isUserOnChatTab(
                    chatTabId,
                    activeTabId,
                    getTab,
                  );

                  if (isPlatformTabMergedWithChat(chatTabId, platformTabId)) {
                    if (autoSwitch) {
                      switchToTab(chatTabId);
                    }
                  } else {
                    openPlatformBrowserTab(platformId, {
                      mergeWithChatTabId: chatTabId,
                      autoSwitch,
                    });
                  }
                } catch (platformMergeErr) {
                  console.warn(
                    "[useAgent] Could not merge platform browser with chat:",
                    platformMergeErr,
                  );
                }
              }
            }
          }
          break;

        case "text-delta":
          {
            // Append delta to streaming content
            const text = (chunk.payload as { text: string }).text || "";
            if (!text || isRateLimitWaitDelta(text)) {
              break;
            }
            const currentContent =
              streamingContentRef.current.get(chatId) || "";
            streamingContentRef.current.set(chatId, currentContent + text);

            // Also accumulate for sequence tracking
            const currentSegment =
              currentTextSegmentRef.current.get(chatId) || "";
            currentTextSegmentRef.current.set(chatId, currentSegment + text);

            // Batch updates to avoid excessive re-renders (update every 50ms max)
            const existingTimeout = updateBatchRef.current.get(chatId);
            if (existingTimeout) {
              clearTimeout(existingTimeout);
            }
            const newTimeout = setTimeout(() => {
              const streamingMessageId =
                streamingMessageIdRef.current.get(chatId);
              const content = streamingContentRef.current.get(chatId);
              if (streamingMessageId && content !== undefined) {
                updateStreamingMessage(streamingMessageId, content, chatId);
                getUiStreamProfiler(chatId)?.mark("ui.textPaint");
              }
              updateBatchRef.current.delete(chatId);
            }, 50); // Update at most every 50ms (20 FPS)
            updateBatchRef.current.set(chatId, newTimeout);
          }
          break;

        case "wrap-up-start":
          setFinishingWork(chatId, true);
          break;

        case "done":
          {
            // A completed turn proves the credentials work again, so retire any
            // rejection we recorded for this provider.
            const succeededProvider = providerForModelId(
              useChatStore.getState().getLastSelectedModel(chatId),
            );
            if (succeededProvider) {
              useProviderAuthStore.getState().clearRejection(succeededProvider);
            }

            // Clear any pending batch update for this chat
            const existingTimeout = updateBatchRef.current.get(chatId);
            if (existingTimeout) {
              clearTimeout(existingTimeout);
              updateBatchRef.current.delete(chatId);
            }
            // Also flush any pending reasoning batch
            const existingReasoningTimeout = reasoningBatchRef.current.get(chatId);
            if (existingReasoningTimeout) {
              clearTimeout(existingReasoningTimeout);
              reasoningBatchRef.current.delete(chatId);
            }

            // ✅ Use finalMessage from backend when available (Codex, or when streaming chunks missed)
            const payload = (
              chunk as { payload?: { finalMessage?: Record<string, unknown> } }
            ).payload;
            const finalMessageFromBackend = payload?.finalMessage;
            const doneMessageId =
              finalMessageFromBackend &&
              typeof finalMessageFromBackend.id === "string"
                ? finalMessageFromBackend.id
                : undefined;

            const chatStateForDone = useChatStore
              .getState()
              .chatStates.get(chatId);

            // agent:complete (broadcast) can deliver a second done after the stream
            // chunk already finalized — skip only when that exact message is saved.
            if (
              finalMessageFromBackend &&
              typeof finalMessageFromBackend.id === "string" &&
              chatStateForDone &&
              shouldIgnoreDuplicateDoneChunk({
                finalMessageId: finalMessageFromBackend.id,
                messages: chatStateForDone.messages,
                hasActiveStreamingMessageId:
                  streamingMessageIdRef.current.has(chatId),
                isSending: chatStateForDone.isSending,
              })
            ) {
              console.log(
                `[useAgent] Ignoring duplicate done for ${chatId} (stream already finalized)`,
              );
              untrackActiveStream(chatId);
              settleChatAfterStreamEnd(chatId);
              const { setTabStreaming: clearTabStreaming } =
                useTabStore.getState();
              clearTabStreaming(`chat-${chatId}`, false);
              break;
            }

            if (
              doneMessageId &&
              chatStateForDone?.messages.some(
                (m) =>
                  m.role === "assistant" &&
                  m.id === doneMessageId &&
                  !m.isStreaming,
              )
            ) {
              console.log(
                `[useAgent] Ignoring duplicate done for ${chatId} (${doneMessageId})`,
              );
              streamingMessageIdRef.current.delete(chatId);
              streamingContentRef.current.delete(chatId);
              streamingReasoningRef.current.delete(chatId);
              toolCallsMapRef.current.delete(chatId);
              sequenceRef.current.delete(chatId);
              currentTextSegmentRef.current.delete(chatId);
              untrackActiveStream(chatId);
              settleChatAfterStreamEnd(chatId);
              const { setTabStreaming: clearTabStreaming } =
                useTabStore.getState();
              clearTabStreaming(`chat-${chatId}`, false);
              break;
            }

            const streamingMessageIdEarly =
              streamingMessageIdRef.current.get(chatId) ??
              useChatStore
                .getState()
                .chatStates.get(chatId)
                ?.messages.find((m) => m.role === "assistant" && m.isStreaming)
                ?.id;

            const hasLocalStreamData =
              (sequenceRef.current.get(chatId)?.length ?? 0) > 0 ||
              (toolCallsMapRef.current.get(chatId)?.size ?? 0) > 0 ||
              Boolean(streamingContentRef.current.get(chatId)?.trim());

            if (
              finalMessageFromBackend &&
              typeof finalMessageFromBackend.id === "string" &&
              !hasLocalStreamData
            ) {
              const mapped = mapHistoryMessages([finalMessageFromBackend])[0];
              const chatStateEarly =
                useChatStore.getState().chatStates.get(chatId);
              if (mapped && chatStateEarly) {
                const streamIdx = streamingMessageIdEarly
                  ? chatStateEarly.messages.findIndex(
                      (m) => m.id === streamingMessageIdEarly,
                    )
                  : -1;
                const finalized = {
                  ...mapped,
                  isStreaming: false,
                  streamingContent: undefined,
                  streamingReasoning: undefined,
                };

                let messages = chatStateEarly.messages;
                if (streamIdx >= 0) {
                  messages = [
                    ...messages.slice(0, streamIdx),
                    finalized,
                    ...messages
                      .slice(streamIdx + 1)
                      .filter((m) => m.id !== finalized.id),
                  ];
                } else if (!messages.some((m) => m.id === finalized.id)) {
                  messages = [...messages, finalized];
                } else {
                  messages = messages.map((m) =>
                    m.id === finalized.id ? finalized : m,
                  );
                }

                const newChatStates = new Map(
                  useChatStore.getState().chatStates,
                );
                newChatStates.set(chatId, {
                  ...chatStateEarly,
                  messages,
                  isStreaming: false,
                });
                useChatStore.setState({ chatStates: newChatStates });
                clearStreamingState(chatId);
                streamingMessageIdRef.current.delete(chatId);
                streamingContentRef.current.delete(chatId);
                streamingReasoningRef.current.delete(chatId);
                toolCallsMapRef.current.delete(chatId);
                sequenceRef.current.delete(chatId);
                currentTextSegmentRef.current.delete(chatId);
                untrackActiveStream(chatId);
                settleChatAfterStreamEnd(chatId);
                const { setTabStreaming } = useTabStore.getState();
                setTabStreaming(`chat-${chatId}`, false);
                break;
              }
            }

            // ✅ SEQUENCE: Build final sequence from streaming refs OR fallback to backend's finalMessage
            const currentSegment =
              currentTextSegmentRef.current.get(chatId) || "";
            let sequence = sequenceRef.current.get(chatId) || [];
            let finalReasoning = streamingReasoningRef.current.get(chatId);
            let content = streamingContentRef.current.get(chatId);
            let chatToolCalls = toolCallsMapRef.current.get(chatId);

            // Only use backend finalMessage when the client has no live stream data
            if (
              finalMessageFromBackend &&
              typeof finalMessageFromBackend === "object" &&
              sequence.length === 0 &&
              (!chatToolCalls || chatToolCalls.size === 0) &&
              !content &&
              (finalMessageFromBackend.sequence ||
                finalMessageFromBackend.reasoning ||
                finalMessageFromBackend.toolCalls)
            ) {
              const fm = finalMessageFromBackend as {
                sequence?: Array<{ type: string; data: unknown }>;
                reasoning?: string;
                toolCalls?: Array<{
                  id: string;
                  toolName: string;
                  args?: unknown;
                  status: string;
                  result?: string;
                }>;
                content?: string;
              };
              if (fm.sequence && fm.sequence.length > 0) {
                // Only replace sequence if client-side sequence is empty
                // This prevents losing delegation cards and other client-side state
                if (sequence.length === 0) {
                  sequence = fm.sequence;
                  console.log(
                    `[useAgent] Using backend sequence (${sequence.length} items)`,
                  );
                } else {
                  console.log(
                    `[useAgent] Keeping client-side sequence (${sequence.length} items), backend had ${fm.sequence.length} items`,
                  );
                }
              }
              if (
                (fm.reasoning || (fm as { thinking?: string }).thinking) &&
                !finalReasoning
              ) {
                finalReasoning =
                  fm.reasoning || (fm as { thinking?: string }).thinking;
              }
              if (
                fm.toolCalls &&
                fm.toolCalls.length > 0 &&
                (!chatToolCalls || chatToolCalls.size === 0)
              ) {
                const map = new Map<
                  string,
                  {
                    id: string;
                    toolName: string;
                    args?: unknown;
                    status: string;
                    result?: string;
                  }
                >();
                fm.toolCalls.forEach((tc) => {
                  const id =
                    tc.id || `tool-${Date.now()}-${tc.toolName || tc.name}`;
                  map.set(id, {
                    id,
                    toolName:
                      tc.toolName || (tc as { name?: string }).name || "tool",
                    args: tc.args,
                    status: tc.status || "success",
                    result: tc.result,
                  });
                });
                chatToolCalls = map;
              }
              if (fm.content && !content) {
                content = fm.content;
              }
            }

            // Add thinking to beginning of sequence if present (from streaming)
            if (
              finalReasoning &&
              finalReasoning.trim() &&
              !sequence.some((item) => item.type === "thinking")
            ) {
              console.log(`[useAgent] Adding thinking to sequence`);
              sequence = [
                { type: "thinking", data: finalReasoning.trim() },
                ...sequence,
              ];
            }

            // Add any remaining text segment (final text after all tools)
            if (currentSegment.trim()) {
              console.log(
                `[useAgent] Adding final text to sequence: "${currentSegment.trim().substring(0, 50)}..."`,
              );
              sequence = [
                ...sequence,
                { type: "text", data: currentSegment.trim() },
              ];
              sequenceRef.current.set(chatId, sequence);
            }

            // Settles isSending first so no empty loading indicator appears,
            // and preserves a refusal banner the error chunk raised moments
            // ago — see settleChatAfterStreamEnd.
            settleChatAfterStreamEnd(chatId);

            // Clear streaming status (blue dot) for THIS chat's tab
            const { setTabStreaming } = useTabStore.getState();
            setTabStreaming(`chat-${chatId}`, false);

            // Flush final update immediately
            const streamingMessageId =
              streamingMessageIdRef.current.get(chatId);

            if (streamingMessageId) {
              // Update message with final sequence we built
              const { chatStates } = useChatStore.getState();
              const chatState = chatStates.get(chatId);
              if (chatState) {
                const toolCallsArray = chatToolCalls
                  ? Array.from(chatToolCalls.values())
                  : [];
                console.log(
                  `[useAgent] Finalizing with ${sequence.length} sequence items`,
                );

                const streamIdx = chatState.messages.findIndex(
                  (m) => m.id === streamingMessageId,
                );
                const existingStreaming =
                  streamIdx >= 0 ? chatState.messages[streamIdx] : undefined;

                let finalizedMessage = {
                  ...(existingStreaming ?? {
                    id: streamingMessageId,
                    role: "assistant" as const,
                    content: "",
                  }),
                  content: content || "",
                  reasoning: finalReasoning || existingStreaming?.reasoning,
                  toolCalls:
                    toolCallsArray.length > 0
                      ? toolCallsArray
                      : existingStreaming?.toolCalls,
                  sequence:
                    sequence.length > 0 ? sequence : existingStreaming?.sequence,
                  isStreaming: false,
                  streamingContent: undefined,
                  streamingReasoning: undefined,
                };

                // Prefer the server-assigned message id so reload matches DB history
                if (
                  finalMessageFromBackend &&
                  typeof finalMessageFromBackend.id === "string"
                ) {
                  const mapped = mapHistoryMessages([
                    finalMessageFromBackend,
                  ])[0];
                  if (mapped) {
                    finalizedMessage = {
                      ...mapped,
                      content: content || mapped.content,
                      reasoning: finalReasoning || mapped.reasoning,
                      toolCalls:
                        toolCallsArray.length > 0
                          ? toolCallsArray
                          : mapped.toolCalls,
                      sequence:
                        sequence.length > 0 ? sequence : mapped.sequence,
                      isStreaming: false,
                      streamingContent: undefined,
                      streamingReasoning: undefined,
                    };
                  }
                }

                let updatedMessages = chatState.messages.map((msg) =>
                  msg.id === streamingMessageId ? finalizedMessage : msg,
                );
                if (finalizedMessage.id !== streamingMessageId) {
                  updatedMessages = updatedMessages.filter(
                    (msg, index, all) =>
                      msg.id !== finalizedMessage.id ||
                      all.findIndex((m) => m.id === finalizedMessage.id) ===
                        index,
                  );
                }

                const newChatStates = new Map(chatStates);
                newChatStates.set(chatId, {
                  ...chatState,
                  messages: updatedMessages,
                  isStreaming: false,
                });
                useChatStore.setState({ chatStates: newChatStates });
              }

              // Flush streaming slice into final message state
              flushStreamingState(chatId, {
                content: content || "",
                reasoning: finalReasoning || undefined,
                sequence: sequence.length > 0 ? sequence : undefined,
                toolCalls: chatToolCalls
                  ? (Array.from(chatToolCalls.values()) as any)
                  : undefined,
                isStreaming: false,
              });

              streamingMessageIdRef.current.delete(chatId);
              streamingContentRef.current.delete(chatId);
              streamingReasoningRef.current.delete(chatId);
              toolCallsMapRef.current.delete(chatId);
              sequenceRef.current.delete(chatId); // Clear sequence
              currentTextSegmentRef.current.delete(chatId); // Clear text segment
            } else if (
              finalMessageFromBackend &&
              typeof finalMessageFromBackend.id === "string"
            ) {
              const mapped = mapHistoryMessages([finalMessageFromBackend])[0];
              const chatStateFallback =
                useChatStore.getState().chatStates.get(chatId);
              if (mapped && chatStateFallback) {
                const streamingIdx = chatStateFallback.messages.findIndex(
                  (m) => m.role === "assistant" && m.isStreaming,
                );
                const finalized = { ...mapped, isStreaming: false };

                let messages = chatStateFallback.messages;
                if (streamingIdx >= 0) {
                  messages = [
                    ...messages.slice(0, streamingIdx),
                    finalized,
                    ...messages
                      .slice(streamingIdx + 1)
                      .filter((m) => m.id !== finalized.id),
                  ];
                } else if (!messages.some((m) => m.id === finalized.id)) {
                  messages = [...messages, finalized];
                } else {
                  messages = messages.map((m) =>
                    m.id === finalized.id ? finalized : m,
                  );
                }

                const newChatStates = new Map(
                  useChatStore.getState().chatStates,
                );
                newChatStates.set(chatId, {
                  ...chatStateFallback,
                  messages,
                  isStreaming: false,
                });
                useChatStore.setState({ chatStates: newChatStates });
              }
            }
            untrackActiveStream(chatId);
            resetAutoContinueAttempts(chatId);
          }
          break;

        case "error":
          {
            // Handle error
            const payload = chunk.payload as { error: string; code?: string };
            const rawError = payload.error || "Unknown error";

            if (requestId) {
              if (rejectedRequestIdsRef.current.has(requestId)) {
                return;
              }
              const activeRequestId = activeStreamRequests.get(chatId);
              if (activeRequestId && activeRequestId !== requestId) {
                return;
              }
            }

            if (payload.code === PROVIDER_QUOTA_EXHAUSTED_ERROR_CODE) {
              console.warn(
                `[useAgent] Provider quota exhausted for ${chatId} — surfacing the limit, no resume`,
              );
              setSending(chatId, false);
              setWaitingForAgentSlot(chatId, false);
              setConnectionPaused(chatId, false);
              setFinishingWork(chatId, false);
              // The gateway already composed a message naming the limit, the
              // reset time and where to change it, so it is shown as-is rather
              // than swapped for one of the generic rewrites below.
              setError(rawError);
              // The provider refused this turn outright. Recorded separately
              // from the banner because a spent quota offers no Resume, so the
              // banner state alone never carries a refusal.
              setLastTurnOutcome(chatId, "providerRefused");

              const streamingMessageId =
                streamingMessageIdRef.current.get(chatId);
              if (streamingMessageId) {
                const cleaned = stripRateLimitWaitDeltas(
                  streamingContentRef.current.get(chatId) || "",
                );
                streamingContentRef.current.set(chatId, cleaned);
                flushStreamingState(chatId, { isStreaming: false });
              }
              untrackActiveStream(chatId);
              break;
            }

            if (payload.code === RATE_LIMIT_EXHAUSTED_ERROR_CODE) {
              console.warn(
                `[useAgent] Rate limit retries exhausted for ${chatId} — showing resume UI`,
              );
              setSending(chatId, false);
              setWaitingForAgentSlot(chatId, false);
              setConnectionPaused(chatId, false);
              setFinishingWork(chatId, false);
              // Carried into the banner rather than dropped. The gateway names
              // which credential was refused and quotes the provider, and that
              // is the only thing that tells a user whether switching between
              // API key and subscription login changed anything.
              setNeedsStreamRecovery(chatId, true, "rateLimit", rawError);
              // Survives Stop, which clears the banner. Without it, stopping a
              // refused turn erased the evidence of the refusal at exactly the
              // moment the user asked us to stop retrying.
              setLastTurnOutcome(chatId, "providerRefused");
              // Also recorded on `error`, which is global rather than per-chat
              // and so cannot be dropped by a write to this chat's state.
              // Every other copy of this sentence lives in the per-chat banner,
              // and that banner is cleared as a side effect by several callers
              // (setConnectionPaused, cleanupStreamState, the stale sweep) — so
              // relying on it alone is what made a refusal show nothing at all.
              // The sibling quota branch above has always used `error` and has
              // always been visible; this is the same refusal and gets the same
              // treatment. ChatContainer renders whichever one it has, never
              // both, so this does not double up on the banner.
              setError(rawError);

              const streamingMessageId =
                streamingMessageIdRef.current.get(chatId);
              if (streamingMessageId) {
                const cleaned = stripRateLimitWaitDeltas(
                  streamingContentRef.current.get(chatId) || "",
                );
                streamingContentRef.current.set(chatId, cleaned);
                flushStreamingState(chatId, { isStreaming: false });
              }
              untrackActiveStream(chatId);
              break;
            }

            // Expected when user stops or sends a new message while streaming
            if (isExpectedStreamCancellation(rawError)) {
              console.log(
                "[useAgent] Ignoring expected stream cancellation:",
                rawError,
              );
              break;
            }

            const recoverableDrop = isRecoverableProviderStreamDrop(rawError);

            // Extract provider-specific error messages
            let errorMsg = rawError;

            // Pattern: AI SDK empty stream (often proxy/auth/model mismatch)
            if (rawError.includes("No output generated")) {
              errorMsg =
                "The model returned an empty response. If you don't have your own API keys, sign in with Papr under Settings → AI Models — cloud models route through the Papr proxy. Otherwise try a different model.";
            }
            // Pattern: Internal Server Error (500-level errors from any provider)
            else if (
                rawError.includes("Internal Server Error") ||
                rawError.includes("api_error") ||
                rawError.includes("server error") ||
                rawError.includes("Server Error") ||
                rawError.includes("(529)") ||
                rawError.includes("(500)")
              ) {
                errorMsg = `🔄 The AI provider encountered an internal server error. This is a temporary issue on their side, not your connection. Please try again in a moment, or switch to a different model.`;
              }
              // Pattern: "Your credit balance is too low to access the X API"
              else if (rawError.includes("credit balance is too low")) {
                const providerMatch = rawError.match(/access the (\w+) API/);
                const provider = providerMatch ? providerMatch[1] : "provider";
                errorMsg = `Credit balance too low for ${provider}. Please add credits or switch to a different model.`;
              }
              // Pattern: Connection terminated mid-stream (undici/Node.js "terminated" error)
              // Often a server-side idle timeout on long thinking/tool-heavy turns — not always rate limits.
              else if (recoverableDrop) {
                errorMsg =
                  "The connection to the AI provider was interrupted mid-response (often a timeout on long requests). Paprwork will try to resume automatically.";
              }
              // Pattern: Overloaded errors (server capacity issues)
              else if (
                rawError.includes("overloaded_error") ||
                rawError.includes("Overloaded") ||
                rawError.includes("temporarily overloaded")
              ) {
                errorMsg = `🔄 The AI servers are temporarily overloaded. This is an issue from the provider, not your connection. Please wait a moment and try again, or switch to a different model.`;
              }
              // Pattern: Rate limit errors
              else if (
                rawError.includes("Rate limit exceeded") ||
                rawError.includes("rate limit") ||
                rawError.includes("rate_limit_error") ||
                rawError.includes("Rate limited") ||
                rawError.includes("(429)")
              ) {
                errorMsg = `Rate limit exceeded. Please wait a moment and try again, or switch models.`;
              }
              // Pattern: Composer cloud repo / branch not ready
              else if (
                rawError.includes("Failed to determine repository default branch") ||
                rawError.includes("Failed to verify existence of branch")
              ) {
                errorMsg =
                  "Composer cloud workspace is not ready yet. Paprwork is syncing your GitHub repo — wait a moment and try again. If this persists, open Settings and ensure you are signed in with Papr.";
              }
              else if (
                rawError.includes("agent_not_found") ||
                rawError.includes("Agent not found")
              ) {
                errorMsg =
                  "The cloud agent session expired before your message was processed. Send your message again — Paprwork will start a fresh cloud agent automatically.";
              }
              // Pattern: Invalid API key (specific patterns, not just "API key" anywhere)
              else if (isProviderAuthRejection(rawError)) {
                errorMsg = `Invalid API key. Please check your API key in Settings.`;

                // Remember which account was rejected so the AI Models card can
                // say "reconnect" rather than counting down a stored expiry the
                // provider has stopped honouring.
                const rejectedProvider = providerForModelId(
                  useChatStore.getState().getLastSelectedModel(chatId),
                );
                if (rejectedProvider) {
                  useProviderAuthStore
                    .getState()
                    .recordRejection(rejectedProvider, errorMsg);
                }
              }
              // Pattern: AI SDK tool validation errors (Zod validation failures)
              else if (
                rawError.includes("AI_TypeValidationError") ||
                rawError.includes("invalid_union") ||
                rawError.includes("invalid_type") ||
                (rawError.includes("expected") && rawError.includes("received") && rawError.includes("undefined"))
              ) {
                errorMsg = `⚠️ The AI model returned an invalid tool call. This is usually temporary.\n\nWhat you can do:\n• Try sending your message again\n• Try a different model (e.g., GPT-5.5 → Claude Sonnet)\n• If this persists, please report this issue`;
                
                // Log full technical error to console for debugging
              console.error("[useAgent] Tool validation error (full details):", rawError);
            }

            if (recoverableDrop) {
              console.warn(
                `[useAgent] Recoverable provider stream drop for ${chatId} — marking interrupted for auto-continue:`,
                rawError,
              );
              setError(null);
            } else {
              console.error("[useAgent] Received error chunk:", errorMsg);
              console.error("[useAgent] Full chunk payload:", chunk.payload);
              setError(errorMsg);
            }

            // Set isSending to false FIRST to prevent empty loading indicator from appearing
            setSending(chatId, false);
            setConnectionPaused(chatId, false);
            setFinishingWork(chatId, false);
            
            const streamingMessageId =
              streamingMessageIdRef.current.get(chatId);
            if (streamingMessageId) {
              // Flush any partial streaming state into the message before
              // finalizing — preserves whatever text/tools we already have.
              flushStreamingState(chatId, { isStreaming: false });
              finalizeStreamingMessage(streamingMessageId, chatId);
              if (recoverableDrop) {
                markAssistantTurnInterrupted(chatId, streamingMessageId);
              }
              streamingMessageIdRef.current.delete(chatId);
              streamingContentRef.current.delete(chatId);
              streamingReasoningRef.current.delete(chatId);
              toolCallsMapRef.current.delete(chatId);
            }
            untrackActiveStream(chatId);
          }
          break;

        case "tool-error":
          {
            // Handle tool execution error (bash, filesystem, etc.)
            const toolName = (chunk.payload as any).toolName || "unknown";
            const toolCallId = (chunk.payload as any).toolCallId;
            const rawError = (chunk.payload as { error: unknown }).error;
            const errorMsg =
              typeof rawError === "string"
                ? rawError
                : rawError != null
                  ? JSON.stringify(rawError)
                  : "Tool execution failed";

            console.error(`[useAgent] Tool error (${toolName}):`, errorMsg);

            // Update the tool call with the error result
            const streamingMessageId =
              streamingMessageIdRef.current.get(chatId);
            const chatToolCalls = toolCallsMapRef.current.get(chatId);
            if (toolCallId && streamingMessageId && chatToolCalls) {
              const toolCall = chatToolCalls.get(toolCallId);
              if (toolCall) {
                chatToolCalls.set(toolCallId, {
                  ...toolCall,
                  result: `❌ Error: ${errorMsg}`,
                  status: "error" as const,
                });
                toolCallsMapRef.current.set(chatId, chatToolCalls);

                // Update the message's tool calls
                const { chatStates } = useChatStore.getState();
                const chatState = chatStates.get(chatId);
                if (chatState) {
                  const updatedMessages = chatState.messages.map((msg) =>
                    msg.id === streamingMessageId
                      ? {
                          ...msg,
                          toolCalls: Array.from(chatToolCalls.values()),
                        }
                      : msg,
                  );
                  const newChatStates = new Map(chatStates);
                  newChatStates.set(chatId, {
                    ...chatState,
                    messages: updatedMessages,
                  });
                  useChatStore.setState({ chatStates: newChatStates });
                }
              }
            }
          }
          break;
      }

      const applied = appliedChunkCounts.get(chatId) ?? 0;
      appliedChunkCounts.set(chatId, applied + 1);
    },
    [
      addMessage,
      updateStreamingMessage,
      finalizeStreamingMessage,
      setSending,
      setWaitingForAgentSlot,
      setConnectionPaused,
      setFinishingWork,
      setNeedsStreamRecovery,
      settleChatAfterStreamEnd,
      setError,
      initStreamingState,
      setStreamingText,
      setStreamingReasoning,
      replaceStreamingSequence,
      upsertStreamingToolCall,
      flushStreamingState,
      clearStreamingState,
    ],
  );

  handleStreamChunkRef.current = handleStreamChunk;

  const hasActiveStreamWork = useCallback((chatId: string): boolean => {
    const chatState = useChatStore.getState().chatStates.get(chatId);
    return (
      activeStreamRequests.has(chatId) ||
      streamingMessageIdRef.current.has(chatId) ||
      chatState?.messages.some((m) => m.isStreaming) === true ||
      chatState?.isSending === true ||
      chatState?.isStreaming === true
    );
  }, []);

  const interruptActiveStream = useCallback(
    async (chatId: string): Promise<void> => {
      clearResumeRetry(chatId);
      markResuming(chatId, false);
      cancelSubscribeHandler(chatId);
      useChatStore.getState().setNeedsStreamRecovery(chatId, false);

      const oldRequestId = activeStreamRequests.get(chatId);
      if (oldRequestId) {
        rejectedRequestIdsRef.current.add(oldRequestId);
        gateway.cancelRequest(oldRequestId);
        untrackActiveStream(chatId);
      }

      await gateway
        .send("agent:stop", { chatId }, { timeoutMs: AGENT_INTERRUPT_TIMEOUT_MS })
        .catch((stopError) => {
          console.warn("[useAgent] Failed to stop existing stream:", stopError);
        });

      const existingStreamingMessageId =
        streamingMessageIdRef.current.get(chatId);
      const streamingMessageId =
        existingStreamingMessageId ??
        useChatStore
          .getState()
          .chatStates.get(chatId)
          ?.messages.find((m) => m.isStreaming)?.id;

      if (streamingMessageId) {
        const chatToolCalls = toolCallsMapRef.current.get(chatId);
        if (chatToolCalls) {
          chatToolCalls.forEach((toolCall, toolCallId) => {
            if (toolCall.status === "calling") {
              chatToolCalls.set(toolCallId, {
                ...toolCall,
                status: "error" as const,
                error: "Stopped by user",
              });
            }
          });

          const sequence = sequenceRef.current.get(chatId) || [];
          const updatedSequence = sequence.map((item) => {
            if (
              item.type === "tool" &&
              (item.data as { status?: string })?.status === "calling"
            ) {
              return {
                ...item,
                data: {
                  ...(item.data as object),
                  status: "stopped",
                  error: "Stopped by user",
                },
              };
            }
            return item;
          });
          sequenceRef.current.set(chatId, updatedSequence);

          const { chatStates } = useChatStore.getState();
          const chatState = chatStates.get(chatId);
          if (chatState) {
            const updatedMessages = chatState.messages.map((msg) =>
              msg.id === streamingMessageId
                ? {
                    ...msg,
                    toolCalls: Array.from(chatToolCalls.values()),
                    sequence: updatedSequence,
                    isStreaming: false,
                  }
                : msg,
            );
            const newChatStates = new Map(chatStates);
            newChatStates.set(chatId, {
              ...chatState,
              messages: updatedMessages,
            });
            useChatStore.setState({ chatStates: newChatStates });
          }
        }

        finalizeStreamingMessage(streamingMessageId, chatId);

        if (streamingMessageId) {
          markAssistantTurnInterrupted(chatId, streamingMessageId);
        }
      }

      streamingMessageIdRef.current.delete(chatId);
      streamingContentRef.current.delete(chatId);
      streamingReasoningRef.current.delete(chatId);
      toolCallsMapRef.current.delete(chatId);
      appliedChunkCounts.delete(chatId);
      sequenceRef.current.delete(chatId);
      currentTextSegmentRef.current.delete(chatId);

      setSending(chatId, false);
      setConnectionPaused(chatId, false);
      setFinishingWork(chatId, false);
      useChatStore.getState().setChatStreaming(chatId, false);
      useTabStore.getState().setTabStreaming(`chat-${chatId}`, false);
      clearStreamingState(chatId);
    },
    [
      finalizeStreamingMessage,
      setSending,
      setConnectionPaused,
      clearStreamingState,
    ],
  );

  const resumeInterruptedStream = useCallback(
    async (chatId: string, requestId: string) => {
      rehydrateStreamingRefsForChat(chatId, streamingRefs);
      const fromChunkIndex = appliedChunkCounts.get(chatId) ?? 0;
      console.log(
        `[useAgent] Resuming stream for ${chatId} (requestId=${requestId}, fromChunk=${fromChunkIndex})`,
      );
      clearResumeRetry(chatId);
      setConnectionPaused(chatId, false);
      setFinishingWork(chatId, false);
      setNeedsStreamRecovery(chatId, false);
      setError(null);
      setSending(chatId, true);

      const { setTabStreaming } = useTabStore.getState();
      setTabStreaming(`chat-${chatId}`, true);

      await subscribeWithRetry(
        chatId,
        requestId,
        fromChunkIndex,
        (chunk) => handleStreamChunkRef.current(chunk),
      );
      setError(null);
    },
    [setConnectionPaused, setNeedsStreamRecovery, setSending, setError, streamingRefs],
  );

  const syncStreamFromHistory = useCallback(
    async (
      chatId: string,
      mode: "auto" | "resolve" = "auto",
    ): Promise<{ needsContinue: boolean }> => {
      rehydrateStreamingRefsForChat(chatId, streamingRefs);
      const chatMessages =
        useChatStore.getState().chatStates.get(chatId)?.messages ?? [];
      const streamingMessageId =
        streamingMessageIdRef.current.get(chatId) ??
        chatMessages.find((m) => m.role === "assistant" && m.isStreaming)?.id ??
        [...chatMessages]
          .reverse()
          .find((m) => m.role === "assistant" && m.interrupted)?.id;
      const { setTabStreaming } = useTabStore.getState();
      let shouldCleanup = true;

      const cleanupStreamState = () => {
        streamingMessageIdRef.current.delete(chatId);
        streamingContentRef.current.delete(chatId);
        streamingReasoningRef.current.delete(chatId);
        toolCallsMapRef.current.delete(chatId);
        sequenceRef.current.delete(chatId);
        currentTextSegmentRef.current.delete(chatId);
        untrackActiveStream(chatId);
        // Same four settles as every `done` path, and for the same reason: this
        // runs on reconnect, where finding no live stream is exactly what a
        // refused turn looks like — so clearing unconditionally would erase the
        // refusal we are reconnecting to explain.
        settleChatAfterStreamEnd(chatId);
        setTabStreaming(`chat-${chatId}`, false);
        clearStreamingState(chatId);
      };

      try {
        try {
          const sessionsResp = await gateway.send("agent:sessions", {});
          const sessions =
            (
              sessionsResp.data as {
                sessions?: Array<{ chatId: string; isStreaming: boolean }>;
              }
            )?.sessions ?? [];
          if (sessions.some((s) => s.chatId === chatId && s.isStreaming)) {
            shouldCleanup = false;
            const requestId = ensureTrackedStream(chatId);
            setConnectionPaused(chatId, true);
            setNeedsStreamRecovery(chatId, false);
            scheduleStreamResumeRetry(
              chatId,
              requestId,
              resumeInterruptedStream,
            );
            return { needsContinue: false };
          }
        } catch {
          // Non-fatal — continue with history sync
        }

        const chatState = useChatStore.getState().chatStates.get(chatId);
        if (!chatState) {
          cleanupStreamState();
          return { needsContinue: false };
        }

        const history = await fetchChatHistory(chatId, { limit: 30 });
        const serverMessages = mapHistoryMessages(history);
        let mergedMessages = mergeHistoryWithLocal(
          chatState.messages,
          serverMessages,
          streamingMessageId,
        );

        const serverHasReplacement =
          !!streamingMessageId &&
          serverHasCompletedAssistantForStreamingTurn(
            chatState.messages,
            serverMessages,
            streamingMessageId,
          );
        let stillHasPartialAssistant =
          !!streamingMessageId &&
          !serverHasReplacement &&
          mergedMessages.some((m) => m.id === streamingMessageId);

        if (mode === "resolve" && stillHasPartialAssistant) {
          mergedMessages = finalizeStreamingMessages(mergedMessages);
          stillHasPartialAssistant = false;
        }

        const newChatStates = new Map(useChatStore.getState().chatStates);
        newChatStates.set(chatId, {
          ...chatState,
          messages: mergedMessages,
          isStreaming: mode === "auto" && stillHasPartialAssistant,
          isSending: false,
          connectionPaused: false,
          needsStreamRecovery: mode === "auto" && stillHasPartialAssistant,
        });
        useChatStore.setState({ chatStates: newChatStates });

        if (mode === "resolve") {
          cleanupStreamState();
          return {
            needsContinue: interruptedTurnNeedsContinue(
              mergedMessages,
              streamingMessageId,
              serverHasReplacement,
            ),
          };
        }

        if (stillHasPartialAssistant) {
          shouldCleanup = false;
        }

        return { needsContinue: false };
      } catch (syncError) {
        console.error(
          `[useAgent] Failed to sync stream from history for ${chatId}:`,
          syncError,
        );
        const chatState = useChatStore.getState().chatStates.get(chatId);
        if (chatState && streamingMessageId) {
          if (mode === "resolve") {
            const finalized = finalizeStreamingMessages(chatState.messages);
            const newChatStates = new Map(useChatStore.getState().chatStates);
            newChatStates.set(chatId, {
              ...chatState,
              messages: finalized,
              isStreaming: false,
              isSending: false,
              connectionPaused: false,
              needsStreamRecovery: false,
            });
            useChatStore.setState({ chatStates: newChatStates });
            cleanupStreamState();
            const streamingMsg = finalized.find((m) => m.id === streamingMessageId);
            return {
              needsContinue: interruptedTurnNeedsContinue(
                finalized,
                streamingMessageId,
                !streamingMsg,
              ),
            };
          }

          shouldCleanup = false;
          const newChatStates = new Map(useChatStore.getState().chatStates);
          newChatStates.set(chatId, {
            ...chatState,
            isStreaming: false, // Don't keep Working indicator on a failed sync
            isSending: false,
            connectionPaused: false,
            needsStreamRecovery: true,
            messages: finalizeStreamingMessages(chatState.messages),
          });
          useChatStore.setState({ chatStates: newChatStates });
          clearStreamingState(chatId);
        }
        return { needsContinue: false };
      } finally {
        if (shouldCleanup) {
          cleanupStreamState();
        }
      }
    },
    [
      clearStreamingState,
      resumeInterruptedStream,
      setConnectionPaused,
      setFinishingWork,
      setNeedsStreamRecovery,
      settleChatAfterStreamEnd,
      setError,
      setSending,
      streamingRefs,
    ],
  );

  const continueInterruptedTurn = useCallback(
    async (chatId: string, config: AgentConfig) => {
      console.log(
        `[useAgent] Starting hidden continue turn for ${chatId}`,
      );
      clearResumeRetry(chatId);
      setNeedsStreamRecovery(chatId, false);
      setConnectionPaused(chatId, false);
      setFinishingWork(chatId, false);
      setError(null);

      const { setTabStreaming } = useTabStore.getState();
      setTabStreaming(`chat-${chatId}`, true);
      setSending(chatId, true);

      const chatMessages =
        useChatStore.getState().chatStates.get(chatId)?.messages ?? [];
      const reuseAssistantMessageId = [...chatMessages]
        .reverse()
        .find((m) => m.role === "assistant" && m.interrupted)?.id;

      streamingMessageIdRef.current.delete(chatId);
      streamingContentRef.current.delete(chatId);
      streamingReasoningRef.current.delete(chatId);
      toolCallsMapRef.current.delete(chatId);
      appliedChunkCounts.set(chatId, 0);

      const focusContext = resolveAgentFocusContext(chatId);
      await gateway.stream(
        "agent:stream",
        {
          chatId,
          message: HIDDEN_CONTINUE_USER_MESSAGE,
          config,
          ...(reuseAssistantMessageId
            ? { reuseAssistantMessageId }
            : {}),
          ...(focusContext ? { focusContext } : {}),
        },
        (chunk) => handleStreamChunk(chunk as StreamChunk),
        (requestId) => {
          trackActiveStream(chatId, requestId);
        },
      );
    },
    [
      handleStreamChunk,
      setConnectionPaused,
      setError,
      setNeedsStreamRecovery,
      setSending,
    ],
  );

  const retryStreamRecovery = useCallback(
    async (chatId: string, config?: AgentConfig) => {
      const chatStateBefore = useChatStore.getState().chatStates.get(chatId);
      const wasAwaitingRecovery =
        chatStateBefore?.needsStreamRecovery ?? false;
      const resumeWithFreshStream = shouldResumeWithFreshGatewayStream({
        streamRecoveryReason: chatStateBefore?.streamRecoveryReason,
        lastTurnOutcome: chatStateBefore?.lastTurnOutcome,
      });
      setNeedsStreamRecovery(chatId, false);
      // Tapping Resume is the user deciding to try again, so the refusal or
      // stop that blocked auto-continue no longer applies.
      setLastTurnOutcome(chatId, undefined);
      // Cleared here rather than only on the resumable branch below: a refusal
      // records its sentence on `error` as well as on the banner, so clearing
      // the banner without clearing `error` would reveal the copy underneath
      // and report the refusal a second time on the turn retrying it.
      setError(null);
      setWaitingForAgentSlot(chatId, false);
      clearResumeRetry(chatId);
      rehydrateStreamingRefsForChat(chatId, streamingRefs);

      const releaseServerStream = async (): Promise<void> => {
        await releaseGatewayAgentStream(chatId, {
          onCancelRequest: (requestId) => {
            rejectedRequestIdsRef.current.add(requestId);
            gateway.cancelRequest(requestId);
          },
        });
      };

      if (resumeWithFreshStream && config) {
        await releaseServerStream();
        try {
          await syncStreamFromHistory(chatId, "resolve");
          await continueInterruptedTurn(chatId, config);
        } catch (continueError) {
          const message =
            continueError instanceof Error
              ? continueError.message
              : String(continueError);
          if (message === GATEWAY_DISCONNECTED_ERROR) {
            setConnectionPaused(chatId, true);
            setNeedsStreamRecovery(chatId, true);
            return;
          }
          console.error(
            `[useAgent] Fresh resume after provider backoff failed for ${chatId}:`,
            continueError,
          );
          setError(message);
          setNeedsStreamRecovery(chatId, true);
        }
        return;
      }

      let requestId = activeStreamRequests.get(chatId);
      if (!requestId) {
        const stillStreaming = await chatIsStreamingOnServer(chatId);
        if (stillStreaming) {
          requestId = ensureTrackedStream(chatId);
        }
      }

      if (requestId) {
        setConnectionPaused(chatId, true);
        setError(null);
        try {
          await resumeInterruptedStream(chatId, requestId);
          return;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (message === GATEWAY_DISCONNECTED_ERROR) {
            setConnectionPaused(chatId, true);
            setNeedsStreamRecovery(chatId, true);
            return;
          }
          if (message.includes("Retry shortly")) {
            setConnectionPaused(chatId, true);
            scheduleStreamResumeRetry(
              chatId,
              requestId,
              resumeInterruptedStream,
            );
            return;
          }
          console.warn(
            `[useAgent] Stream resubscribe failed for ${chatId}, resolving from history:`,
            error,
          );
        }
      }

      const { needsContinue } = await syncStreamFromHistory(chatId, "resolve");
      if (needsContinue) {
        if (!config) {
          setError(
            "Could not reconnect to the stream. Send a new message to continue.",
          );
          if (wasAwaitingRecovery) {
            setNeedsStreamRecovery(chatId, true);
          }
          return;
        }
        try {
          await releaseServerStream();
          await continueInterruptedTurn(chatId, config);
        } catch (continueError) {
          const message =
            continueError instanceof Error
              ? continueError.message
              : String(continueError);
          if (message === GATEWAY_DISCONNECTED_ERROR) {
            setConnectionPaused(chatId, true);
            setNeedsStreamRecovery(chatId, true);
            return;
          }
          console.error(
            `[useAgent] Hidden continue turn failed for ${chatId}:`,
            continueError,
          );
          setError(message);
          if (wasAwaitingRecovery) {
            setNeedsStreamRecovery(chatId, true);
          }
        }
      } else if (wasAwaitingRecovery) {
        setNeedsStreamRecovery(chatId, true);
        setError(
          "Could not resume automatically. Send a new message to continue.",
        );
      }
    },
    [
      continueInterruptedTurn,
      resumeInterruptedStream,
      setConnectionPaused,
      setError,
      setLastTurnOutcome,
      setNeedsStreamRecovery,
      setWaitingForAgentSlot,
      streamingRefs,
      syncStreamFromHistory,
    ],
  );

  const retryStreamRecoveryRef = useRef(retryStreamRecovery);
  retryStreamRecoveryRef.current = retryStreamRecovery;

  /**
   * A turn delivered no first chunk at all. Two causes, and they need different
   * remedies, so probe rather than guess:
   *
   * - Socket dead (half-open: we think it is open, the server has already run
   *   `removeSubscriber`). Closing it runs the existing reconnect + resume path,
   *   so there is nothing more to do here.
   * - Socket fine, but the server no longer lists us as a subscriber for this
   *   stream. Resubscribe; `retryStreamRecovery` falls back to history if the
   *   stream is already finished.
   *
   * The original promise is released first so the send lock frees and the
   * heartbeat drops back to its strict cadence. `isSending` is deliberately
   * left true — the answer is still coming, and recovery owns that state.
   */
  const handleFirstChunkStall = useCallback(
    async (stall: FirstChunkStall, config?: AgentConfig) => {
      const { chatId, requestId, waitedMs } = stall;
      console.warn(
        `[useAgent] No first chunk for ${chatId} after ${waitedMs}ms ` +
          `(stream ${requestId}) — probing the socket before recovering`,
      );

      gateway.cancelRequest(requestId, FIRST_CHUNK_STALL_CANCEL_REASON);

      const alive = await gateway.probeConnection();
      if (!alive) {
        // onclose → rejectActiveStreamHandlers → reconnect → resume.
        console.warn(
          `[useAgent] Socket was dead for ${chatId} — reconnect will resume the stream`,
        );
        setConnectionPaused(chatId, true);
        return;
      }

      try {
        await retryStreamRecoveryRef.current(chatId, config);
      } catch (error) {
        console.error(
          `[useAgent] First-chunk recovery failed for ${chatId}:`,
          error,
        );
        setError(
          error instanceof Error
            ? error.message
            : "Lost contact with the agent. Send a new message to continue.",
        );
        setSending(chatId, false);
      }
    },
    [setConnectionPaused, setError, setSending],
  );

  useEffect(() => {
    ensureGatewayRecoveryRegistered();

    const resumeAllActiveStreams = async () => {
      const activeStreams = [...activeStreamRequests.entries()];

      for (const [chatId, requestId] of activeStreams) {
        if (isResumingStream(chatId)) continue;
        markResuming(chatId, true);
        try {
          await resumeInterruptedStream(chatId, requestId);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (message === GATEWAY_DISCONNECTED_ERROR) {
            setConnectionPaused(chatId, true);
            continue;
          }
          if (message.includes("Retry shortly")) {
            setConnectionPaused(chatId, true);
            scheduleStreamResumeRetry(
              chatId,
              requestId,
              resumeInterruptedStream,
            );
            continue;
          }
          console.warn(
            `[useAgent] Stream resume failed for ${chatId}, syncing history:`,
            error,
          );
          await syncStreamFromHistory(chatId);
        } finally {
          markResuming(chatId, false);
        }
      }

      await clearStalePausedChats();

      const retryStreamRecoveryFn = retryStreamRecoveryRef.current;
      for (const chatId of listChatsForPostReconnectStreamRecovery()) {
        const config = buildRecoveryAgentConfigForChat(chatId);
        if (!config) continue;
        markPostReconnectStreamRecoveryAttempted(chatId);
        console.log(
          `[useAgent] Auto-retrying stream recovery for ${chatId} after reconnect`,
        );
        try {
          await retryStreamRecoveryFn(chatId, config);
        } catch (error) {
          console.warn(
            `[useAgent] Post-reconnect stream recovery failed for ${chatId}:`,
            error,
          );
        }
      }
    };

    setRecoverStreamsHandler(resumeAllActiveStreams);
    // Keep handler registered when ChatContainer unmounts (tab switch) so
    // reconnect can still resume in-flight streams.
  }, [
    resumeInterruptedStream,
    syncStreamFromHistory,
    setConnectionPaused,
    retryStreamRecovery,
  ]);

  // Global gateway-broadcast listener (see ensureAgentStreamBroadcastListener).
  useEffect(() => {
    setAgentStreamChunkHandler(handleStreamChunk);
  }, [handleStreamChunk]);

  // Send message to agent
  const sendMessage = useCallback(
    async (
      message: string,
      config: AgentConfig,
      chatId: string, // ✅ Now passed explicitly, not derived from activeTab
      attachments?: MessageAttachment[],
    ): Promise<void> => {
      console.log("=".repeat(80));
      console.log("[useAgent.sendMessage] ========== START ==========");
      console.log("[useAgent.sendMessage] Message:", message);
      console.log("[useAgent.sendMessage] ChatId:", chatId);

      const { setTabStreaming, setTabUnread, updateTabId } =
        useTabStore.getState();

      const isFirstMessage = chatId.startsWith("temp-");
      let finalChatId = chatId; // Will be updated if temp
      const tabId = `chat-${chatId}`;
      const hiddenContinue = isHiddenContinueUserMessage(message);
      const userMessageId = `msg-user-${Date.now()}`;

      const interruptIfActive = async (targetChatId: string): Promise<void> => {
        if (!hasActiveStreamWork(targetChatId)) {
          return;
        }
        console.log(
          `[useAgent] Interrupting active stream for ${targetChatId}`,
        );
        await Promise.race([
          interruptActiveStream(targetChatId),
          new Promise<void>((resolve) => {
            setTimeout(resolve, AGENT_INTERRUPT_TIMEOUT_MS);
          }),
        ]);
      };

      const priorSend = sendMessageLockRef.current.get(chatId);
      if (priorSend) {
        if (hiddenContinue) {
          await priorSend.catch(() => {});
        } else {
          console.warn(
            `[useAgent] Preempting hung prior send for ${chatId} — user message takes priority`,
          );
          sendMessageLockRef.current.delete(chatId);
          await interruptIfActive(chatId);
        }
      } else if (!hiddenContinue) {
        await interruptIfActive(chatId);
      }

      const myGeneration = nextSendGeneration(
        sendGenerationRef.current,
        chatId,
      );

      let releaseSendLock: (() => void) | undefined;
      const sendLock = new Promise<void>((resolve) => {
        releaseSendLock = resolve;
      });
      sendMessageLockRef.current.set(chatId, sendLock);

      const isSendCurrent = (targetChatId: string): boolean =>
        isSendGenerationCurrent(
          sendGenerationRef.current,
          targetChatId,
          myGeneration,
        );

      console.log(
        "[useAgent.sendMessage]   - Is first message:",
        isFirstMessage,
      );
      console.log("=".repeat(80));

      try {
        if (!hiddenContinue) {
          resetAutoContinueAttempts(chatId);
          setLastTurnOutcome(chatId, undefined);
          // Retired alongside the outcome: a refusal banner now outlives the
          // stream that raised it, so without this a real user message leaves
          // a Resume button offering to retry the turn they just replaced.
          // Gated on the same hidden-continue check, so an auto-continue
          // cannot clear the banner that is meant to be blocking it.
          setNeedsStreamRecovery(chatId, false);
        }

        setTabStreaming(tabId, true);
        setSending(chatId, true);
        addMessage(
          {
            id: userMessageId,
            role: "user",
            content: message,
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          },
          chatId,
        );
        console.log("[useAgent] User message added to store (optimistic)");

        // V1 APPROACH: Create permanent chat BEFORE streaming if temp
        if (isFirstMessage) {
          console.log(
            "[useAgent] First message - creating permanent chat before streaming",
          );
          const createResponse = await gateway.send("chat:create", {});
          const newChatId = (createResponse.data as any)?.chatId;

          if (!newChatId) {
            throw new Error("Failed to create chat - no chatId returned");
          }

          console.log(`[useAgent] Created permanent chat: ${newChatId}`);

          useChatStore.getState().migrateChatId(chatId, newChatId);

          const memoryScope = useChatStore.getState().getChatMemoryScope(chatId);
          if (memoryScope !== "user") {
            try {
              await gateway.send("chat:update", {
                chatId: newChatId,
                memoryScope,
              });
            } catch (scopeError) {
              console.warn(
                "[useAgent] Failed to persist memory scope on new chat:",
                scopeError,
              );
            }
          }

          // Update tab ID synchronously (like V1)
          updateTabId(tabId, `chat-${newChatId}`);
          console.log(`[useAgent] Updated tab: ${tabId} → chat-${newChatId}`);

          finalChatId = newChatId; // Use permanent ID for streaming
          sendGenerationRef.current.set(finalChatId, myGeneration);

          const tempLock = sendMessageLockRef.current.get(chatId);
          if (tempLock) {
            sendMessageLockRef.current.delete(chatId);
            sendMessageLockRef.current.set(finalChatId, tempLock);
          }

          setSending(chatId, false);
          setSending(finalChatId, true);
          setTabStreaming(tabId, false);
          setTabStreaming(`chat-${finalChatId}`, true);

          scheduleChatTitleGeneration(finalChatId, message);
        }

        if (finalChatId !== chatId) {
          await interruptIfActive(finalChatId);
        }

        // Reset streaming state for this chatId
        resetAgentStreamingRefsForChat(finalChatId);
        appliedChunkCounts.set(finalChatId, 0);

        setError(null);
        console.log("[useAgent] State reset, about to call gateway.stream");

        startUiStreamProfiler(finalChatId);
        getUiStreamProfiler(finalChatId)?.mark("ui.beforeGatewayStream");

        // Stream message via WebSocket (with permanent chatId)
        const focusContext = resolveAgentFocusContext(finalChatId);
        await gateway.stream(
          "agent:stream",
          {
            chatId: finalChatId, // Always permanent at this point
            message,
            config,
            ...(focusContext ? { focusContext } : {}),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          },
          (chunk) => handleStreamChunk(chunk as StreamChunk),
          (requestId) => {
            trackActiveStream(finalChatId, requestId);
            armFirstChunkWatchdog({
              chatId: finalChatId,
              requestId,
              onStall: (stall) => {
                void handleFirstChunkStall(stall, config);
              },
            });
          },
        );
        console.log("[useAgent] gateway.stream completed successfully");

        // Set tab unread status if not active (green dot)
        // The streaming status (blue dot) was already cleared by the "done" chunk
        const currentActiveTabId = useTabStore.getState().activeTabId;
        const newTabId = `chat-${finalChatId}`;
        if (currentActiveTabId !== newTabId) {
          setTabUnread(newTabId, true);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const isDisconnectError = errorMessage === GATEWAY_DISCONNECTED_ERROR;

        if (!isSendCurrent(finalChatId)) {
          console.log(
            `[useAgent] Ignoring error from superseded send for ${finalChatId}`,
          );
          return;
        }

        if (isDisconnectError) {
          console.log(
            `[useAgent] Gateway disconnected mid-stream for ${finalChatId} — will resume on reconnect`,
          );
          setConnectionPaused(finalChatId, true);
          return;
        }

        if (isExpectedStreamCancellation(errorMessage)) {
          console.log(
            "[useAgent] Ignoring expected stream cancellation from prior send:",
            errorMessage,
          );
          return;
        }

        if (activeStreamRequests.has(finalChatId)) {
          console.log(
            `[useAgent] Ignoring error from superseded stream for ${finalChatId}`,
          );
          return;
        }

        console.error("[useAgent] sendMessage error:", error);
        if (error instanceof Error) {
          console.error("[useAgent] Stack trace:", error.stack);
        }
        setError(errorMessage);
        setSending(finalChatId, false);
        setTabStreaming(`chat-${finalChatId}`, false);
      } finally {
        if (isSendCurrent(finalChatId)) {
          finishUiStreamProfiler(finalChatId);
        }
        releaseSendLock?.();
        const lockChatId = finalChatId !== chatId ? finalChatId : chatId;
        if (sendMessageLockRef.current.get(lockChatId) === sendLock) {
          sendMessageLockRef.current.delete(lockChatId);
        }
        if (
          finalChatId !== chatId &&
          sendMessageLockRef.current.get(chatId) === sendLock
        ) {
          sendMessageLockRef.current.delete(chatId);
        }
      }
    },
    [
      addMessage,
      setSending,
      setConnectionPaused,
      setError,
      handleStreamChunk,
      hasActiveStreamWork,
      interruptActiveStream,
    ],
  );

  // Get chat history
  const getHistory = useCallback(
    async (sessionId: string) => {
      try {
        const response = await gateway.send("agent:history", {
          chatId: sessionId,
        });
        return response.data || [];
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setError(errorMessage);
        return [];
      }
    },
    [setError],
  );

  // Clear chat history
  const clearHistory = useCallback(
    async (sessionId: string) => {
      try {
        await gateway.send("agent:clear", { sessionId });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setError(errorMessage);
      }
    },
    [setError],
  );

  const autoContinueInterruptedTurn = useCallback(
    async (chatId: string, config: AgentConfig, messages: ChatMessage[]) => {
      if (
        !shouldAutoContinueInterruptedTurn({
          chatId,
          messages,
          isSending:
            useChatStore.getState().chatStates.get(chatId)?.isSending ?? false,
          connectionPaused:
            useChatStore.getState().chatStates.get(chatId)?.connectionPaused ??
            false,
          needsStreamRecovery:
            useChatStore.getState().chatStates.get(chatId)
              ?.needsStreamRecovery ?? false,
          streamRecoveryReason:
            useChatStore.getState().chatStates.get(chatId)
              ?.streamRecoveryReason,
          lastTurnOutcome:
            useChatStore.getState().chatStates.get(chatId)?.lastTurnOutcome,
          gatewayReady: gateway.isConnected(),
        })
      ) {
        return;
      }

      const attempt = recordAutoContinueAttempt(chatId, messages);
      console.log(
        `[useAgent] Auto-continuing interrupted turn for ${chatId} (attempt ${attempt}/3) — trying stream recovery first`,
      );

      try {
        await retryStreamRecovery(chatId, config);
      } catch (error) {
        console.warn(
          `[useAgent] Auto-continue attempt ${attempt} failed for ${chatId}:`,
          error,
        );
      }
    },
    [retryStreamRecovery],
  );

  return {
    sendMessage,
    getHistory,
    clearHistory,
    interruptActiveStream,
    retryStreamRecovery,
    autoContinueInterruptedTurn,
  };
}

// Explicitly export the type to help TypeScript
export type UseAgentReturn = {
  sendMessage: (
    message: string,
    config: AgentConfig,
    chatId: string,
    attachments?: MessageAttachment[],
  ) => Promise<void>;
  getHistory: (sessionId: string) => Promise<unknown>;
  clearHistory: (sessionId: string) => Promise<void>;
  interruptActiveStream: (chatId: string) => Promise<void>;
  retryStreamRecovery: (chatId: string, config?: AgentConfig) => Promise<void>;
  autoContinueInterruptedTurn: (
    chatId: string,
    config: AgentConfig,
    messages: ChatMessage[],
  ) => Promise<void>;
};
