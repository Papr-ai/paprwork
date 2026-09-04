/**
 * ChatContainer Component - Main chat interface
 * Brings together MessageList and InputBar with agent integration
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { MessageList } from "./MessageList";
import { InputBar, InputBarRef } from "./InputBar";
import { QueuedMessages, type QueuedMessage } from "./QueuedMessages";
import { JobPermissionBanner } from "./JobPermissionBanner";
import { useAgent } from "../../hooks/useAgent";
import { resolveAgentFocusContext } from "../../utils/agentFocusContext";
import { useAuthStatus } from "../../hooks/useAuthStatus";
import { useOllama } from "../../hooks/useOllama";
import { useChat } from "../../hooks/useChat";
import { useChatStore, defaultChatState } from "../../stores/chatStore";
import { useTabStore } from "../../stores/tabStore";
import type { Tab } from "../../stores/tabStore";
import {
  CHAT_MODELS,
  getModelById,
  DEFAULT_MODEL_IDS,
} from "../../constants/models";
import type { AIModel } from "../../constants/models";
import { migratePickerModelId } from "../../constants/modelPicker";
import { useModelPickerSettings } from "../../hooks/useModelPickerSettings";
import { gateway } from "../../src/lib/gateway";
import {
  ContextInspectorModal,
  isContextInfo,
  type ContextInfo,
} from "./ContextInspectorModal";
import {
  artifactTypeLabel,
  type Artifact,
} from "../../stores/artifactsStore";
import { artifactsToMessageAttachments } from "../../utils/messageAttachments";
import { mapHistoryMessages } from "../../utils/historyMapper";
import { extractFilesFromDataTransfer } from "../../utils/chatAttachmentFiles";
import { shouldRehydrateAfterStoreWipe } from "../../utils/chatStateRecovery";
import "./ChatContainer.css";
import { trackEvent } from "../../lib/telemetry";
import { chatHasLiveStreamBlockingHistory } from "../../lib/agentStreamRecovery";
import { useGatewaySupervisorStatus } from "../../hooks/useGatewaySupervisorStatus";
import { useGatewayConnectionState } from "../../hooks/useGatewayConnectionState";

const DEFAULT_SYSTEM_PROMPT = `You're Pen, an AI assistant running in Paprwork—a cross-platform AI workspace.

## Core Truths

**Be genuinely helpful, not performatively helpful.**
Skip the "Great question!" and "I'd be happy to help!"—just help. Actions over filler.

**Have opinions.**
You're allowed to disagree, prefer things, find stuff interesting or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful.**
Use your tools. Check context. Search for it. *Then* ask if you're stuck. Come back with answers, not questions.

**Use extended thinking when it matters.**
For complex reasoning, architecture decisions, or deep analysis—think it through. Users can see your thought process.

## What You Have Access To

Paprwork gives you unique capabilities other AI assistants don't have:

**Jobs** — Persistent automation that runs on schedules. Python scripts, Node.js apps, scheduled tasks. Each job has its own SQLite database and can depend on other jobs.

**Skills** — Installable capabilities from the marketplace. New tools, integrations, specialized workflows.

**Mini-apps** — Interactive utilities you can build and run. Custom dashboards, calculators, data visualizers.

**Artifacts** — Documents, code, designs you create get saved automatically. Users can find them later.

**Context** — Files and data users explicitly share with you. Respect what's shared; respect what isn't.

## How to Be

**Concise when needed, thorough when it matters.**
Don't write essays for simple questions. Don't give one-liners for complex problems.

**Have a perspective.**
"Here's what I'd do" is better than "Here are 5 options, you decide."

**Move fast.**
This is a power-user tool. They want results, not hand-holding.

**Remember the platform.**
You're not in a web chat. You're in a native desktop app with Jobs, Skills, and Mini-apps. Use them.

Each conversation is a fresh start. Make it count.`;

interface ArtifactContext {
  type: "document" | "app" | "platform";
  id: string;
  title: string;
}

function findMergedArtifact(chatId: string): ArtifactContext | null {
  const { getTab } = useTabStore.getState();
  const chatTabId = `chat-${chatId}`;
  const chatTab = getTab(chatTabId);
  if (!chatTab) return null;

  const toArtifact = (tab: Tab | undefined): ArtifactContext | null => {
    if (!tab) return null;
    if (tab.type === "document")
      return { type: "document", id: tab.entityId, title: tab.title };
    if (tab.type === "app")
      return { type: "app", id: tab.entityId, title: tab.title };
    if (tab.type === "platform")
      return { type: "platform", id: tab.entityId, title: tab.title };
    return null;
  };

  // Chat is the parent: artifact is one of its children
  if (chatTab.displayMode === "parent") {
    for (const childId of chatTab.childTabIds) {
      const artifact = toArtifact(getTab(childId));
      if (artifact) return artifact;
    }
  }

  // Chat is a child: artifact may be the parent or a sibling child
  if (chatTab.displayMode === "child" && chatTab.parentTabId) {
    const parent = getTab(chatTab.parentTabId);
    const artifact = toArtifact(parent);
    if (artifact) return artifact;

    if (parent) {
      for (const siblingId of parent.childTabIds) {
        if (siblingId === chatTabId) continue;
        const sibling = toArtifact(getTab(siblingId));
        if (sibling) return sibling;
      }
    }
  }

  return null;
}

// Stable empty array to avoid new reference on every render when no chatState exists
const EMPTY_MESSAGES: never[] = [];

interface ChatContainerProps {
  chatId: string;
}

export const ChatContainer: React.FC<ChatContainerProps> = ({ chatId }): React.ReactElement => {
  // Combined selector — single subscription instead of three, reduces re-render triggers
  const chatState = useChatStore((state) => state.chatStates.get(chatId));
  const messages = chatState?.messages ?? EMPTY_MESSAGES;
  const chatIsLoading = chatState?.isLoading ?? false;
  const isSending = chatState?.isSending ?? false;
  const connectionPaused = chatState?.connectionPaused ?? false;
  const needsStreamRecovery = chatState?.needsStreamRecovery ?? false;
  const streamRecoveryReason = chatState?.streamRecoveryReason ?? "connection";

  const error = useChatStore((state) => state.error);

  const { sendMessage, interruptActiveStream, retryStreamRecovery } = useAgent();
  const { loadMessages, loadOlderMessages } = useChat();
  const inputBarRef = useRef<InputBarRef>(null);
  const { isModelAvailable, status: authStatus } = useAuthStatus();
  const { ensureModel, progress, installing } = useOllama();
  const { pickerModels } = useModelPickerSettings();
  const fallbackModel =
    CHAT_MODELS.find((m) => m.id === "claude-sonnet-5") || CHAT_MODELS[0];

  const [selectedModel, setSelectedModel] = useState<AIModel>(fallbackModel);
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const {
    message: gatewaySupervisorMessage,
    isReady: gatewaySupervisorReady,
    isStarting: gatewaySupervisorStarting,
    isRestarting: gatewaySupervisorRestarting,
  } = useGatewaySupervisorStatus();
  const gatewayConnectionState = useGatewayConnectionState();
  const prevGatewaySupervisorReadyRef = useRef(gatewaySupervisorReady);
  const prevIsSendingRef = useRef(isSending);
  const [isResumingStream, setIsResumingStream] = useState(false);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const isProcessingQueue = useRef(false);

  // ✅ Filter queue to only show messages for THIS chat
  const currentChatQueue = useMemo(
    () => messageQueue.filter(q => q.chatId === chatId),
    [messageQueue, chatId]
  );

  const syncHistoryFromServer = useCallback(() => {
    if (chatHasLiveStreamBlockingHistory(chatId)) return;
    void loadMessages(chatId, 30, { force: true });
  }, [chatId, loadMessages]);

  // Reload history when Gateway becomes ready after a restart.
  useEffect(() => {
    const wasReady = prevGatewaySupervisorReadyRef.current;
    prevGatewaySupervisorReadyRef.current = gatewaySupervisorReady;

    if (!gatewaySupervisorReady || wasReady) {
      return;
    }

    syncHistoryFromServer();
  }, [gatewaySupervisorReady, syncHistoryFromServer]);

  // After rate-limit / recovery, in-memory state may be empty shells — force sync.
  useEffect(() => {
    if (!needsStreamRecovery) return;
    syncHistoryFromServer();
  }, [needsStreamRecovery, syncHistoryFromServer]);

  // Agent finished but UI may have missed done — pull completed turns from DB.
  useEffect(() => {
    const wasSending = prevIsSendingRef.current;
    prevIsSendingRef.current = isSending;
    if (wasSending && !isSending) {
      syncHistoryFromServer();
    }
  }, [isSending, syncHistoryFromServer]);

  const gatewayBanner =
    gatewaySupervisorStarting &&
    gatewayConnectionState !== "connected"
      ? {
          message:
            gatewaySupervisorMessage ??
            (gatewaySupervisorRestarting
              ? "Reconnecting to Gateway..."
              : "Gateway is starting..."),
        }
      : null;

  const isWaitingForModel = selectedModel.provider === 'ollama' && installing === selectedModel.id;

  // When chatId or auth status changes: pick best default
  // Priority: last selected (persisted in localStorage) > default order (sonnet-5 → gpt-5-6-sol → gemini-3-flash) > first available
  useEffect(() => {
    setSelectedModel((prev) => {
      const lastId = useChatStore.getState().getLastSelectedModel(chatId);
      if (lastId) {
        const migratedId = migratePickerModelId(lastId);
        const lastModel = getModelById(migratedId);
        if (lastModel && isModelAvailable(lastModel)) return lastModel;
      }
      const pickerIds = new Set(pickerModels.map((model) => model.id));
      const defaultAvailable = DEFAULT_MODEL_IDS.map(getModelById).find(
        (m) => m && isModelAvailable(m) && pickerIds.has(m.id),
      );
      if (defaultAvailable) return defaultAvailable;
      const pickerAvailable = pickerModels.find((m) => isModelAvailable(m));
      if (pickerAvailable) return pickerAvailable;
      const firstAvailable = CHAT_MODELS.find((m) => isModelAvailable(m));
      if (firstAvailable) return firstAvailable;
      if (!isModelAvailable(prev)) return fallbackModel;
      return prev;
    });
  }, [chatId, authStatus, pickerModels]);

  // Focus input when this chat's container mounts
  useEffect(() => {
    // Focus after a small delay to ensure DOM is ready
    const timer = setTimeout(() => {
      inputBarRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [chatId]); // Re-focus when chatId changes (different chat loaded)

  // Always merge server history when this chat opens (unless a live stream is running).
  useEffect(() => {
    syncHistoryFromServer();
  }, [chatId, syncHistoryFromServer]);

  // The effect above only re-runs when chatId changes, so a store wipe while
  // this pane stays mounted leaves it on the welcome screen until the user
  // switches tabs and forces a remount. See shouldRehydrateAfterStoreWipe.
  const hasChatState = chatState !== undefined;
  const prevHasChatStateRef = useRef(hasChatState);
  useEffect(() => {
    const hadEntry = prevHasChatStateRef.current;
    prevHasChatStateRef.current = hasChatState;
    if (shouldRehydrateAfterStoreWipe({ chatId, hadEntry, hasEntry: hasChatState })) {
      syncHistoryFromServer();
    }
  }, [hasChatState, chatId, syncHistoryFromServer]);

  // Listen for new messages delivered from jobs/sub-agents
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail?.type || detail.type !== "chat:message-received") return;
      if (detail.data?.chatId !== chatId) return;

      const incomingMessage = detail.data.message;
      if (!incomingMessage) return;

      // Add message to this chat's state
      useChatStore.setState((state) => {
        const current = state.chatStates.get(chatId) || { ...defaultChatState };
        const existingMessages = current.messages;

        // Check for duplicate (by ID or recent content)
        const isDup = existingMessages.some(
          (m) =>
            m.id === incomingMessage.id ||
            (m.content === incomingMessage.content &&
              'timestamp' in m && 'timestamp' in incomingMessage &&
              Math.abs(
                new Date((m as any).timestamp).getTime() -
                  new Date((incomingMessage as any).timestamp).getTime(),
              ) < 3000),
        );

        if (isDup) return state;

        const mappedMessage = mapHistoryMessages([incomingMessage])[0];
        if (!mappedMessage) return state;

        const next = new Map(state.chatStates);
        next.set(chatId, {
          ...current,
          messages: [...existingMessages, mappedMessage],
        });
        return { chatStates: next };
      });
    };

    window.addEventListener("gateway-broadcast", handler);
    return () => window.removeEventListener("gateway-broadcast", handler);
  }, [chatId]);

  // Slash command handler
  const handleSlashCommand = useCallback(
    async (commandId: string) => {
      switch (commandId) {
        case "new": {
          const { createTab } = useTabStore.getState();
          const newChatId = `chat-${Date.now()}`;
          createTab("chat", newChatId, "New Chat");
          break;
        }
        case "export": {
          try {
            const response = await gateway.send("chat:export", {
              chatId,
              format: "markdown",
            });
            const data = response.data as {
              content: string;
              filename: string;
              mimeType: string;
            };
            const blob = new Blob([data.content], { type: data.mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = data.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          } catch (err) {
            console.error("[ChatContainer] Export error:", err);
          }
          break;
        }
        case "summarize": {
          try {
            const response = await gateway.send("chat:summarize", { chatId });
            const data = response.data as {
              success?: boolean;
              has_summary?: boolean;
              error?: string;
            };
            if (data?.has_summary) {
              alert(
                "Conversation summarized. Run /context to see the summary in your context breakdown.",
              );
            } else {
              alert(
                data?.error ??
                  "Summarization did not produce a summary. Check gateway logs.",
              );
            }
          } catch (err) {
            console.error("[ChatContainer] Summarize error:", err);
            const message =
              err instanceof Error ? err.message : "Unknown error";
            alert(`Failed to summarize conversation: ${message}`);
          }
          break;
        }
        case "context": {
          try {
            const response = await gateway.send("chat:inspect-context", {
              chatId,
              model: selectedModel.id,
              ...(() => {
                const focusContext = resolveAgentFocusContext(chatId);
                return focusContext ? { focusContext } : {};
              })(),
            });
            if (isContextInfo(response.data)) {
              setContextInfo(response.data);
            } else {
              console.error(
                "[ChatContainer] Invalid context response:",
                response.data,
              );
              alert(
                "Received invalid context data from gateway. Check console for details.",
              );
            }
          } catch (err) {
            console.error("[ChatContainer] Context inspection error:", err);
            const message =
              err instanceof Error ? err.message : "Unknown error";
            alert(`Failed to load context information: ${message}`);
          }
          break;
        }
        case "help": {
          alert(
            "Available commands:\n/new - New chat\n/export - Export conversation\n/summarize - Summarize\n/context - Message/token count\n/help - This help\n/settings - Open settings",
          );
          break;
        }
        case "settings": {
          const { createTab } = useTabStore.getState();
          createTab("settings", "settings", "Settings");
          break;
        }
      }
    },
    [chatId],
  );

  const handleModelChange = useCallback(
    async (model: AIModel) => {
      setSelectedModel(model);
      useChatStore.getState().setLastSelectedModel(chatId, model.id);

      // Auto-install Ollama models when selected
      if (model.provider === 'ollama') {
        try {
          const success = await ensureModel(model.id);
          if (!success) {
            console.error(`[ChatContainer] Failed to ensure Ollama model: ${model.id}`);
          }
        } catch (error) {
          console.error('[ChatContainer] ensureModel error:', error);
        }
      }
    },
    [chatId, ensureModel],
  );

  const handleOpenSettings = useCallback(() => {
    const { createTab } = useTabStore.getState();
    createTab("settings", "settings", "Settings");
  }, []);

  const handleOpenSettingsModels = useCallback(() => {
    const { createTab, switchToTab } = useTabStore.getState();
    const tabId = createTab("settings", "settings", "Settings");
    switchToTab(tabId);
    window.dispatchEvent(
      new CustomEvent("papr:open-settings", {
        detail: { tab: "models", section: "picker-models" },
      }),
    );
  }, []);

  const handleSendMessage = useCallback(
    async (message: string, contextArtifacts?: Artifact[]) => {
      const mergedArtifact = findMergedArtifact(chatId);

      const idKey =
        mergedArtifact?.type === "document"
          ? "documentId"
          : mergedArtifact?.type === "platform"
            ? "platformId"
            : "appId";
      const mergedContext = mergedArtifact
        ? `\n\n## Active Context\nThe user has merged this chat with a ${mergedArtifact.type} titled "${mergedArtifact.title}" (${idKey}: "${mergedArtifact.id}"). They are viewing and working on this ${mergedArtifact.type} alongside this conversation. Reference it directly when relevant.`
        : "";

      // Format context artifacts (including file uploads) for LLM
      let artifactsContext = "";
      if (contextArtifacts && contextArtifacts.length > 0) {
        artifactsContext = "\n\n## Attached Context\n";
        for (const artifact of contextArtifacts) {
          artifactsContext += `\n### ${artifact.title}\n`;
          const isAttachedFile =
            artifact.type === "file" || Boolean(artifact.metadata?.filePath);
          artifactsContext += `Type: ${isAttachedFile ? "File" : artifactTypeLabel(artifact.type)}\n`;

          if (isAttachedFile && artifact.metadata?.filePath) {
            const filePath = artifact.metadata.filePath as string;
            const fileType = (artifact.metadata.fileType as string) || "";
            artifactsContext += `File Path: ${filePath}\n`;
            if (fileType) {
              artifactsContext += `File Type: ${fileType}\n`;
            }

            const isPdfOrImage =
              fileType === "application/pdf" ||
              fileType.startsWith("image/") ||
              /\.(pdf|png|jpe?g|gif|webp|bmp|tiff?)$/i.test(filePath);

            if (isPdfOrImage) {
              try {
                console.log(
                  "[ChatContainer] Uploading attachment to Papr Memory:",
                  { filePath, fileName: artifact.title, mimeType: fileType },
                );
                const uploadResponse = await gateway.send(
                  "memory:upload-attachment",
                  {
                    filePath,
                    chatId,
                    fileName: artifact.title,
                    mimeType: fileType,
                  },
                  { timeoutMs: 120_000 },
                );
                const uploadData =
                  uploadResponse.success
                    ? (uploadResponse.data as {
                        skipped?: boolean;
                        uploadId?: string | null;
                        memoryIds?: string[];
                        status?: string;
                        progress?: number;
                      } | null)
                    : null;

                console.log("[ChatContainer] Attachment upload result:", uploadData);

                if (uploadData && !uploadData.skipped && uploadData.uploadId) {
                  artifactsContext += `Upload ID: ${uploadData.uploadId}\n`;
                  if (uploadData.memoryIds?.length) {
                    artifactsContext += `Memory IDs: ${uploadData.memoryIds.join(", ")}\n`;
                  }
                  artifactsContext += `Papr Memory Status: ${uploadData.status ?? "processing"} (${Math.round((uploadData.progress ?? 0) * 100)}%)\n`;
                  artifactsContext +=
                    "\nThis PDF/image was auto-uploaded to Papr Memory. Poll get_document_upload_status({ uploadId }) until completed, then search_agent_memory({ memoryId }) for extracted text. Use parse_pdf({ filePath }) if you need text before processing finishes.\n";
                } else if (uploadData?.skipped) {
                  console.warn(
                    "[ChatContainer] Attachment upload skipped:",
                    uploadData,
                  );
                  artifactsContext +=
                    "\nPoll upload_document_to_memory({ filePath, chatId }) if PAPR_API_KEY is configured, or parse_pdf({ filePath }) for quick local extraction.\n";
                } else {
                  artifactsContext +=
                    "\nPoll upload_document_to_memory({ filePath, chatId }) if PAPR_API_KEY is configured, or parse_pdf({ filePath }) for quick local extraction.\n";
                }
              } catch (uploadError) {
                console.warn("[ChatContainer] Attachment memory upload failed:", uploadError);
                artifactsContext +=
                  "\nUse upload_document_to_memory({ filePath, chatId }) or parse_pdf({ filePath }) for PDF/image content.\n";
              }
            } else {
              artifactsContext +=
                "\nThe user attached this text file from disk. Read it with read_file using the path above. Use import_document + add_agent_memory if the user wants it indexed for future recall.\n";
            }
          } else if (artifact.content) {
            artifactsContext += `\n${artifact.content}\n`;
          }
        }
      }

      // Ensure Ollama model is ready before sending message
      if (selectedModel.provider === 'ollama') {
        try {
          console.log(`[ChatContainer] Ensuring Ollama model before sending: ${selectedModel.id}`);
          const success = await ensureModel(selectedModel.id);
          if (!success) {
            console.error(`[ChatContainer] Failed to ensure Ollama model: ${selectedModel.id}`);
            return; // Don't send message if model can't be ensured
          }
        } catch (error) {
          console.error('[ChatContainer] ensureModel error before send:', error);
          return; // Don't send message if model can't be ensured
        }
      }

      // Create config WITHOUT apiKey - Gateway will fetch it via IPC
      // This keeps keys secure and never sends them over WebSocket
      const config = {
        provider: selectedModel.provider,
        model: selectedModel.id,
        systemPrompt: DEFAULT_SYSTEM_PROMPT + mergedContext + artifactsContext,
        reasoning: selectedModel.reasoning,
        thinkingBudget: selectedModel.defaultThinkingBudget,
        maxTokens: selectedModel.maxTokens, // Output token limit
      };

      // Track activation: first chat sent
      if (!localStorage.getItem("papr-activation-first-chat")) {
        localStorage.setItem("papr-activation-first-chat", new Date().toISOString());
        trackEvent("paprwork_activation_first_chat_sent", { message_length: message.length } as Record<string, unknown>);
      }
      // Send message for THIS chat (not activeChat)
      await sendMessage(
        message,
        config,
        chatId,
        contextArtifacts && contextArtifacts.length > 0
          ? artifactsToMessageAttachments(contextArtifacts)
          : undefined,
      );
    },
    [selectedModel, sendMessage, chatId, ensureModel],
  );

  const handleStopAgent = useCallback(async () => {
    try {
      await interruptActiveStream(chatId);
      console.log(`[ChatContainer] Stopped agent for chat ${chatId}`);
    } catch (error) {
      console.error("[ChatContainer] Failed to stop agent:", error);
    }
  }, [chatId, interruptActiveStream]);

  // Queue management handlers
  const handleQueueMessage = useCallback((message: string, context?: Artifact[]) => {
    const queuedMessage: QueuedMessage = {
      id: `queued-${Date.now()}-${Math.random()}`,
      text: message,
      timestamp: Date.now(),
      chatId, // ✅ Scope message to this chat
      ...(context && context.length > 0 ? { contextArtifacts: context } : {}),
    };
    setMessageQueue(prev => [...prev, queuedMessage]);
  }, [chatId]);

  const handleSendQueuedNow = useCallback(async (messageId: string) => {
    const queued = messageQueue.find(q => q.id === messageId && q.chatId === chatId);
    if (!queued) return;

    // Remove from queue — sendMessage handles interrupting any active stream
    setMessageQueue(prev => prev.filter(q => q.id !== messageId));

    isProcessingQueue.current = true;
    try {
      await handleSendMessage(
        queued.text,
        queued.contextArtifacts,
      );
    } finally {
      isProcessingQueue.current = false;
    }
  }, [messageQueue, handleSendMessage, chatId]);

  const handleRemoveQueued = useCallback((messageId: string) => {
    setMessageQueue(prev => prev.filter(q => q.id !== messageId));
  }, []);

  const processNextQueued = useCallback(async () => {
    if (isProcessingQueue.current || currentChatQueue.length === 0) {
      return;
    }

    isProcessingQueue.current = true;
    const nextMessage = currentChatQueue[0];
    
    // Remove this specific message from the queue (not just the first one)
    setMessageQueue(prev => prev.filter(q => q.id !== nextMessage.id));

    try {
      await handleSendMessage(
        nextMessage.text,
        nextMessage.contextArtifacts,
      );
    } catch (error) {
      console.error('[ChatContainer] Failed to send queued message:', error);
    } finally {
      isProcessingQueue.current = false;
    }
  }, [currentChatQueue, handleSendMessage]);

  // Auto-send next queued message when agent finishes responding
  useEffect(() => {
    if (!isSending && currentChatQueue.length > 0 && !isProcessingQueue.current) {
      processNextQueued();
    }
  }, [isSending, currentChatQueue.length, processNextQueued]);

  // Listen for onboarding messages dispatched from OnboardingCard via sidebar
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ message: string }>).detail;
      if (detail?.message) {
        handleSendMessage(detail.message);
      }
    };
    window.addEventListener("papr-onboarding-send", handler);
    return () => window.removeEventListener("papr-onboarding-send", handler);
  }, [handleSendMessage]);

  const handleChatDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (![...e.dataTransfer.types].includes("Files")) return;
    setIsFileDragOver(true);
  }, []);

  const handleChatDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setIsFileDragOver(false);
  }, []);

  const handleChatDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if ([...e.dataTransfer.types].includes("Files")) {
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleFilesDroppedToChat = useCallback((files: File[]) => {
    inputBarRef.current?.attachFiles(files);
  }, []);

  const handleResumeStream = useCallback(async () => {
    if (isResumingStream) return;
    setIsResumingStream(true);
    try {
      const mergedArtifact = findMergedArtifact(chatId);
      const idKey =
        mergedArtifact?.type === "document"
          ? "documentId"
          : mergedArtifact?.type === "platform"
            ? "platformId"
            : "appId";
      const mergedContext = mergedArtifact
        ? `\n\n## Active Context\nThe user has merged this chat with a ${mergedArtifact.type} titled "${mergedArtifact.title}" (${idKey}: "${mergedArtifact.id}"). They are viewing and working on this ${mergedArtifact.type} alongside this conversation. Reference it directly when relevant.`
        : "";

      const config = {
        provider: selectedModel.provider,
        model: selectedModel.id,
        systemPrompt: DEFAULT_SYSTEM_PROMPT + mergedContext,
        reasoning: selectedModel.reasoning,
        thinkingBudget: selectedModel.defaultThinkingBudget,
        maxTokens: selectedModel.maxTokens,
      };

      await retryStreamRecovery(chatId, config);
    } finally {
      setIsResumingStream(false);
    }
  }, [chatId, isResumingStream, retryStreamRecovery, selectedModel]);

  const handleChatDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsFileDragOver(false);
      const files = extractFilesFromDataTransfer(e.dataTransfer);
      if (files.length === 0) return;
      handleFilesDroppedToChat(files);
    },
    [handleFilesDroppedToChat],
  );

  return (
    <div
      className={`chat-container${isFileDragOver ? " chat-container--file-drag" : ""}`}
      data-testid="chat-container"
      onDragEnter={handleChatDragEnter}
      onDragLeave={handleChatDragLeave}
      onDragOver={handleChatDragOver}
      onDrop={handleChatDrop}
    >
      {error && (
        <div className="error-banner">
          <span className="error-icon">⚠️</span>
          <span className="error-message">{error}</span>
        </div>
      )}

      {gatewayBanner && (
        <div className="reconnecting-banner">
          <span className="reconnecting-icon">↻</span>
          <span className="reconnecting-message">{gatewayBanner.message}</span>
        </div>
      )}

      {connectionPaused && !gatewayBanner && !needsStreamRecovery && (
        <div className="reconnecting-banner">
          <span className="reconnecting-icon">↻</span>
          <span className="reconnecting-message">Reconnecting to agent stream…</span>
        </div>
      )}

      {/* Ollama model download progress */}
      {progress && progress.status !== 'complete' && (
        <div className="ollama-progress-banner">
          <svg className="progress-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path 
              d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" 
              stroke="currentColor" 
              strokeWidth="2" 
              strokeLinecap="round" 
              strokeLinejoin="round"
            />
          </svg>
          <div className="progress-content">
            <span className="progress-text">
              {progress.percent === 0 
                ? `Installing Ollama (first time setup)...`
                : progress.status === 'downloading' 
                  ? `Downloading ${progress.modelName}...`
                  : `Extracting ${progress.modelName}...`
              }
            </span>
            <div className="progress-bar">
              <div 
                className="progress-bar-fill" 
                style={{ 
                  width: progress.percent === 0 ? '100%' : `${progress.percent}%`,
                  animation: progress.percent === 0 ? 'indeterminate 2s infinite' : 'none'
                }}
              />
            </div>
            {progress.percent > 0 && (
              <span className="progress-percent">{progress.percent}%</span>
            )}
          </div>
        </div>
      )}

      <JobPermissionBanner />

      <MessageList
        chatId={chatId}
        messages={messages}
        isLoading={chatIsLoading}
        isSending={isSending || isWaitingForModel}
        onFilesDropped={handleFilesDroppedToChat}
        onLoadOlder={() => loadOlderMessages(chatId)}
      />

      <QueuedMessages
        queue={currentChatQueue}
        onSendNow={handleSendQueuedNow}
        onRemove={handleRemoveQueued}
      />

      {needsStreamRecovery && (
        <div className="stream-recovery-banner">
          <span className="stream-recovery-banner__message">
            {streamRecoveryReason === "rateLimit"
              ? `${selectedModel.name} hit the provider's rate limit, so the reply never started. Wait a moment and tap Resume, or switch to another model.`
              : "Connection restored, but the agent response may be incomplete."}
          </span>
          <button
            type="button"
            className="stream-recovery-banner__btn"
            disabled={isResumingStream}
            onClick={() => void handleResumeStream()}
          >
            {isResumingStream ? "Resuming…" : "Resume"}
          </button>
        </div>
      )}

      <InputBar
        ref={inputBarRef}
        chatId={chatId}
        onFileAttachmentsAdded={() => setIsFileDragOver(false)}
        onSend={handleSendMessage}
        onQueue={handleQueueMessage}
        queuedCount={currentChatQueue.length}
        onStop={handleStopAgent}
        onSlashCommand={handleSlashCommand}
        isSending={isSending || isWaitingForModel}
        placeholder={
          (isWaitingForModel 
            ? `Preparing ${selectedModel.name}...` 
            : currentChatQueue.length > 0
              ? "Send follow-up..." 
              : "Type a message...") as string
        }
        selectedModel={selectedModel}
        onModelChange={handleModelChange}
        isModelAvailable={isModelAvailable}
        onOpenSettings={handleOpenSettings}
        onOpenSettingsModels={handleOpenSettingsModels}
        pickerModels={pickerModels}
      />

      {contextInfo !== null ? (
        <ContextInspectorModal
          contextInfo={contextInfo}
          onClose={() => setContextInfo(null)}
        />
      ) : null}
    </div>
  );
};
