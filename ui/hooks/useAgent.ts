/**
 * useAgent Hook - Manage agent streaming and messages
 * Handles real-time streaming from the AI agent via WebSocket
 */

import { useCallback, useEffect, useRef } from "react";
import {
  isInterruptedToolResult,
  resolveToolCallStatus,
} from "../../src/core/utils/interruptedToolResult";
import { isExpectedStreamCancellation } from "../../src/core/constants/streamCancellation.js";
import type { AgentConfig, StreamChunk } from "../types/core";
import type { MessageAttachment } from "../types/chat";
import { useChatStore } from "../stores/chatStore";
import { useTabStore } from "../stores/tabStore";
import { gateway, GATEWAY_DISCONNECTED_ERROR } from "../src/lib/gateway";
import { fetchChatHistory } from "../utils/chatHistoryApi";
import { mapHistoryMessages } from "../utils/historyMapper";
import { resolveAgentFocusContext } from "../utils/agentFocusContext";
import {
  isAppEditToolName,
  isUserOnChatTab,
  resolveAppIdForAutoOpen,
  shouldAutoOpenArtifactTab,
} from "../utils/resolveAppIdForAutoOpen";
import {
  activeStreamRequests,
  appliedChunkCounts,
  chatIsStreamingOnServer,
  cancelSubscribeHandler,
  clearResumeRetry,
  clearStalePausedChats,
  ensureGatewayRecoveryRegistered,
  ensureTrackedStream,
  finalizeStreamingMessages,
  HIDDEN_CONTINUE_USER_MESSAGE,
  interruptedTurnNeedsContinue,
  isResumingStream,
  lastUserTurnNeedsContinue,
  markResuming,
  mergeHistoryWithLocal,
  rehydrateStreamingRefsForChat,
  scheduleStreamResumeRetry,
  serverHasCompletedAssistantForStreamingTurn,
  setRecoverStreamsHandler,
  subscribeWithRetry,
  trackActiveStream,
  untrackActiveStream,
  type StreamingRefs,
} from "../lib/agentStreamRecovery";
import type { ToolCall } from "../types/core";

const RATE_LIMIT_EXHAUSTED_ERROR_CODE = "rate_limit_exhausted";
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
  const setConnectionPaused = useChatStore((s) => s.setConnectionPaused);
  const setNeedsStreamRecovery = useChatStore((s) => s.setNeedsStreamRecovery);
  const setError = useChatStore((s) => s.setError);
  
  // Streaming state management functions
  const initStreamingState = useChatStore((s) => s.initStreamingState);
  const setStreamingText = useChatStore((s) => s.setStreamingText);
  const setStreamingReasoning = useChatStore((s) => s.setStreamingReasoning);
  const replaceStreamingSequence = useChatStore((s) => s.replaceStreamingSequence);
  const upsertStreamingToolCall = useChatStore((s) => s.upsertStreamingToolCall);
  const flushStreamingState = useChatStore((s) => s.flushStreamingState);
  const clearStreamingState = useChatStore((s) => s.clearStreamingState);

  // ✅ FIX: Use Maps keyed by chatId to support parallel streaming
  const streamingMessageIdRef = useRef<Map<string, string>>(new Map());
  const streamingContentRef = useRef<Map<string, string>>(new Map());
  const streamingReasoningRef = useRef<Map<string, string>>(new Map());
  const toolCallsMapRef = useRef<Map<string, Map<string, ToolCall>>>(new Map());
  const updateBatchRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const reasoningBatchRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  /** Request IDs whose chunks should be ignored after interrupt/stop */
  const rejectedRequestIdsRef = useRef<Set<string>>(new Set());
  /** Serialize sendMessage per chat so interrupt + new stream don't overlap */
  const sendMessageLockRef = useRef<Map<string, Promise<void>>>(new Map());

  // Sequence tracking (V1-style interleaving)
  const sequenceRef = useRef<
    Map<string, Array<{ type: "text" | "tool" | "thinking"; data: any }>>
  >(new Map());
  const currentTextSegmentRef = useRef<Map<string, string>>(new Map());

  const streamingRefs: StreamingRefs = {
    streamingMessageIdRef,
    streamingContentRef,
    streamingReasoningRef,
    toolCallsMapRef,
    sequenceRef,
    currentTextSegmentRef,
  };

  // Listen for Gateway connection changes — populated after handleStreamChunk
  const handleStreamChunkRef = useRef<
    (chunk: StreamChunk) => void
  >(() => {});

  // Handle streaming chunks
  const handleStreamChunk = useCallback(
    (chunk: StreamChunk) => {
      console.log("[useAgent] handleStreamChunk received:", chunk.type, chunk);

      // Extract chatId from chunk (all chunks should have this)
      const streamChunk = chunk as unknown as Record<string, unknown>;
      const chatId =
        typeof streamChunk.chatId === "string" ? streamChunk.chatId : undefined;
      const requestId =
        typeof streamChunk.requestId === "string"
          ? streamChunk.requestId
          : undefined;

      if (!chatId) {
        console.error("[useAgent] Chunk missing chatId:", chunk);
        return;
      }

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

      // Ensure we have a streaming message for all chunk types
      rehydrateStreamingRefsForChat(chatId, streamingRefs);
      if (
        !streamingMessageIdRef.current.has(chatId) &&
        chunk.type !== "done" &&
        chunk.type !== "error" &&
        chunk.type !== "start-step" &&
        chunk.type !== "step-usage"
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
      }

      switch (chunk.type) {
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
              if (
                shouldAutoOpenArtifactTab({
                  toolName: existingCall.toolName,
                  hasError: !!payload.error,
                  hasResult: !!payload.result,
                  parsedResult: (() => {
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
                  })(),
                })
              ) {
                try {
                  const parsedResult =
                    typeof payload.result === "string"
                      ? JSON.parse(payload.result)
                      : payload.result;

                  let docId: string | undefined;
                  let docTitle: string | undefined;
                  let isApp = false;

                  // For create/import, parse from result
                  if (
                    existingCall.toolName === "create_document" ||
                    existingCall.toolName === "import_document" ||
                    existingCall.toolName === "create_app"
                  ) {
                    const docData = parsedResult?.data ?? parsedResult;
                    docId = docData?.id as string | undefined;
                    docTitle = (docData?.title as string) || "Document";
                    isApp = existingCall.toolName === "create_app";
                  }

                  // For app edits, resolve appId from args/result paths
                  if (isAppEditToolName(existingCall.toolName)) {
                    docId = resolveAppIdForAutoOpen({
                      toolName: existingCall.toolName,
                      args: existingCall.args,
                      parsedResult:
                        parsedResult && typeof parsedResult === "object"
                          ? (parsedResult as Record<string, unknown>)
                          : null,
                    });
                    isApp = true;

                    // Resolve title from existing tab if available
                    if (docId) {
                      const existingAppTab = useTabStore.getState().getTab(`app-${docId}`);
                      docTitle = existingAppTab?.title || "App";
                    } else {
                      docTitle = "App";
                    }

                    console.log("[useAgent] app edit auto-open:", {
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

                    if (existingTab) {
                      // Tab exists - just merge with chat (refreshes the view)
                      createArtifactFromChat(chatTabId, existingTabId, { autoSwitch });
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
              }
              updateBatchRef.current.delete(chatId);
            }, 50); // Update at most every 50ms (20 FPS)
            updateBatchRef.current.set(chatId, newTimeout);
          }
          break;

        case "done":
          {
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
            // chunk already finalized — skip to avoid duplicate assistant cards.
            if (
              finalMessageFromBackend &&
              typeof finalMessageFromBackend.id === "string" &&
              !streamingMessageIdRef.current.has(chatId) &&
              chatStateForDone &&
              !chatStateForDone.isSending
            ) {
              const serverId = finalMessageFromBackend.id;
              const alreadySaved = chatStateForDone.messages.some(
                (m) => m.id === serverId && !m.isStreaming,
              );
              const lastAssistant = [...chatStateForDone.messages]
                .reverse()
                .find((m) => m.role === "assistant");
              if (
                alreadySaved ||
                (lastAssistant &&
                  !lastAssistant.isStreaming &&
                  lastAssistant.id !== serverId)
              ) {
                console.log(
                  `[useAgent] Ignoring duplicate done for ${chatId} (stream already finalized)`,
                );
                untrackActiveStream(chatId);
                setSending(chatId, false);
                setConnectionPaused(chatId, false);
                setNeedsStreamRecovery(chatId, false);
                const { setTabStreaming: clearTabStreaming } =
                  useTabStore.getState();
                clearTabStreaming(`chat-${chatId}`, false);
                break;
              }
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
              setSending(chatId, false);
              setConnectionPaused(chatId, false);
              setNeedsStreamRecovery(chatId, false);
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
                setSending(chatId, false);
                setConnectionPaused(chatId, false);
                setNeedsStreamRecovery(chatId, false);
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

            // Set isSending to false FIRST to prevent empty loading indicator from appearing
            setSending(chatId, false);
            setConnectionPaused(chatId, false);
            setNeedsStreamRecovery(chatId, false);
            
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

            if (payload.code === RATE_LIMIT_EXHAUSTED_ERROR_CODE) {
              console.warn(
                `[useAgent] Rate limit retries exhausted for ${chatId} — showing resume UI`,
              );
              setSending(chatId, false);
              setConnectionPaused(chatId, false);
              setNeedsStreamRecovery(chatId, true, "rateLimit");
              setError(null);

              const streamingMessageId =
                streamingMessageIdRef.current.get(chatId);
              if (streamingMessageId) {
                const cleaned = stripRateLimitWaitDeltas(
                  streamingContentRef.current.get(chatId) || "",
                );
                streamingContentRef.current.set(chatId, cleaned);
                flushStreamingState(chatId, { isStreaming: true });
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

            // Extract provider-specific error messages
            let errorMsg = rawError;

            // Pattern: Internal Server Error (500-level errors from any provider)
            if (
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
              // This happens when any provider's server closes the HTTP connection
              // unexpectedly (usage limit hit, server-side timeout, socket reset, etc.)
              else if (rawError === "terminated" || rawError === "socket hang up" || rawError.includes("ECONNRESET")) {
                errorMsg = `The server closed the connection mid-stream. This usually means a usage or rate limit was hit on your subscription. Please wait a moment and try again, or switch to a different model.`;
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
              else if (
                rawError.includes("Invalid API key") ||
                rawError.includes("invalid x-api-key") ||
                rawError.includes("authentication_error") ||
                rawError.includes("(401)")
              ) {
                errorMsg = `Invalid API key. Please check your API key in Settings.`;
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

            console.error("[useAgent] Received error chunk:", errorMsg);
            console.error("[useAgent] Full chunk payload:", chunk.payload);
            setError(errorMsg);

            // Set isSending to false FIRST to prevent empty loading indicator from appearing
            setSending(chatId, false);
            setConnectionPaused(chatId, false);
            
            const streamingMessageId =
              streamingMessageIdRef.current.get(chatId);
            if (streamingMessageId) {
              // Flush any partial streaming state into the message before
              // finalizing — preserves whatever text/tools we already have.
              flushStreamingState(chatId, { isStreaming: false });
              finalizeStreamingMessage(streamingMessageId, chatId);
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
      setConnectionPaused,
      setNeedsStreamRecovery,
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

      await gateway.send("agent:stop", { chatId }).catch((stopError) => {
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
      setNeedsStreamRecovery(chatId, false);
      setSending(chatId, true);

      const { setTabStreaming } = useTabStore.getState();
      setTabStreaming(`chat-${chatId}`, true);

      await subscribeWithRetry(
        chatId,
        requestId,
        fromChunkIndex,
        (chunk) => handleStreamChunkRef.current(chunk),
      );
    },
    [setConnectionPaused, setNeedsStreamRecovery, setSending, streamingRefs],
  );

  const syncStreamFromHistory = useCallback(
    async (
      chatId: string,
      mode: "auto" | "resolve" = "auto",
    ): Promise<{ needsContinue: boolean }> => {
      rehydrateStreamingRefsForChat(chatId, streamingRefs);
      const streamingMessageId =
        streamingMessageIdRef.current.get(chatId) ??
        useChatStore
          .getState()
          .chatStates.get(chatId)
          ?.messages.find((m) => m.role === "assistant" && m.isStreaming)?.id;
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
        setSending(chatId, false);
        setConnectionPaused(chatId, false);
        setNeedsStreamRecovery(chatId, false);
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
            if (mode === "auto") {
              setError("Agent still working — reconnecting to stream…");
            }
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
      setNeedsStreamRecovery,
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
      setError(null);

      const { setTabStreaming } = useTabStore.getState();
      setTabStreaming(`chat-${chatId}`, true);
      setSending(chatId, true);

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
      const wasAwaitingRecovery =
        useChatStore.getState().chatStates.get(chatId)?.needsStreamRecovery ??
        false;
      setNeedsStreamRecovery(chatId, false);
      clearResumeRetry(chatId);
      rehydrateStreamingRefsForChat(chatId, streamingRefs);

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
      setNeedsStreamRecovery,
      streamingRefs,
      syncStreamFromHistory,
    ],
  );

  useEffect(() => {
    ensureGatewayRecoveryRegistered();

    const resumeAllActiveStreams = async () => {
      const activeStreams = [...activeStreamRequests.entries()];
      if (activeStreams.length === 0) {
        await clearStalePausedChats();
        return;
      }

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
    };

    setRecoverStreamsHandler(resumeAllActiveStreams);
    // Keep handler registered when ChatContainer unmounts (tab switch) so
    // reconnect can still resume in-flight streams.
  }, [
    resumeInterruptedStream,
    syncStreamFromHistory,
    setConnectionPaused,
  ]);

  // Listen for broadcast agent chunks (e.g. auto-response to sub-agent questions)
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ type: string; data?: unknown }>)
        .detail;
      if (!detail?.type?.startsWith("agent:")) return;

      if (detail.type === "agent:chunk" && detail.data) {
        const chunk = detail.data as Record<string, unknown>;
        handleStreamChunk(chunk as StreamChunk);
      } else if (detail.type === "agent:complete" && detail.data) {
        const data = detail.data as Record<string, unknown>;
        const chatId = data.chatId as string | undefined;
        if (chatId) {
          handleStreamChunk({
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
          handleStreamChunk({
            type: "error",
            chatId,
            payload: { error: error || "Stream error" },
          } as StreamChunk);
        }
      }
    };

    window.addEventListener("gateway-broadcast", handler);
    return () => window.removeEventListener("gateway-broadcast", handler);
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

      const { setTabStreaming, setTabUnread, updateTabTitle, updateTabId } =
        useTabStore.getState();

      const isFirstMessage = chatId.startsWith("temp-");
      let finalChatId = chatId; // Will be updated if temp
      const tabId = `chat-${chatId}`;

      // Stop any in-flight stream BEFORE waiting on the prior send lock.
      // Otherwise "Send now" on a queued message blocks until the current
      // gateway.stream Promise finishes instead of interrupting immediately.
      const interruptIfActive = async (targetChatId: string): Promise<void> => {
        if (hasActiveStreamWork(targetChatId)) {
          console.log(
            `[useAgent] Interrupting active stream for ${targetChatId}`,
          );
          await interruptActiveStream(targetChatId);
        }
      };

      await interruptIfActive(chatId);

      const priorSend = sendMessageLockRef.current.get(chatId);
      if (priorSend) {
        await priorSend.catch(() => {});
      }

      let releaseSendLock: (() => void) | undefined;
      const sendLock = new Promise<void>((resolve) => {
        releaseSendLock = resolve;
      });
      sendMessageLockRef.current.set(chatId, sendLock);

      console.log(
        "[useAgent.sendMessage]   - Is first message:",
        isFirstMessage,
      );
      console.log("=".repeat(80));

      try {
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

          const tempLock = sendMessageLockRef.current.get(chatId);
          if (tempLock) {
            sendMessageLockRef.current.delete(chatId);
            sendMessageLockRef.current.set(finalChatId, tempLock);
          }
        }

        if (finalChatId !== chatId) {
          await interruptIfActive(finalChatId);
        }

        // Set tab streaming status (blue dot) for THIS chat's tab
        setTabStreaming(`chat-${finalChatId}`, true);

        // Mark sending before adding the user message so loadMessages cannot
        // wipe optimistic UI when the tab entityId switches temp → permanent.
        setSending(finalChatId, true);

        // Add user message immediately to THIS chat
        addMessage(
          {
            id: `msg-user-${Date.now()}`,
            role: "user",
            content: message,
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          },
          finalChatId,
        );
        console.log("[useAgent] User message added to store");

        // Reset streaming state for this chatId
        streamingMessageIdRef.current.delete(finalChatId);
        streamingContentRef.current.delete(finalChatId);
        streamingReasoningRef.current.delete(finalChatId);
        toolCallsMapRef.current.delete(finalChatId);
        appliedChunkCounts.set(finalChatId, 0);

        setError(null);
        console.log("[useAgent] State reset, about to call gateway.stream");

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
          },
        );
        console.log("[useAgent] gateway.stream completed successfully");

        // Generate title after streaming (auth is guaranteed resolved)
        if (isFirstMessage) {
          gateway
            .send("agent:generate-title", {
              chatId: finalChatId,
              message,
            })
            .then((titleResponse) => {
              const title = (titleResponse.data as any)?.title || "New Chat";
              console.log("[useAgent] Generated title:", title);
              updateTabTitle(`chat-${finalChatId}`, title);
            })
            .catch((titleError) => {
              console.error("[useAgent] Failed to generate title:", titleError);
            });
        }

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

        // Clear streaming status on error for THIS chat's tab
        setTabStreaming(`chat-${finalChatId}`, false);
      } finally {
        releaseSendLock?.();
        if (sendMessageLockRef.current.get(chatId) === sendLock) {
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

  return {
    sendMessage,
    getHistory,
    clearHistory,
    interruptActiveStream,
    retryStreamRecovery,
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
};
