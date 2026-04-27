/**
 * ChatContainer Component - Main chat interface
 * Brings together MessageList and InputBar with agent integration
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { MessageList } from "./MessageList";
import { InputBar, InputBarRef } from "./InputBar";
import { QueuedMessages, type QueuedMessage } from "./QueuedMessages";
import { useAgent } from "../../hooks/useAgent";
import { useAuthStatus } from "../../hooks/useAuthStatus";
import { useOllama } from "../../hooks/useOllama";
import { useChatStore, defaultChatState } from "../../stores/chatStore";
import { useTabStore } from "../../stores/tabStore";
import type { Tab } from "../../stores/tabStore";
import {
  CHAT_MODELS,
  getModelById,
  DEFAULT_MODEL_IDS,
} from "../../constants/models";
import type { AIModel } from "../../constants/models";
import { mapHistoryMessages } from "../../utils/historyMapper";
import { fetchChatHistory } from "../../utils/chatHistoryApi";
import { gateway } from "../../src/lib/gateway";
import { JobPermissionBanner } from "./JobPermissionBanner";
import { ContextInspectorModal } from "./ContextInspectorModal";
import {
  artifactTypeLabel,
  type Artifact,
} from "../../stores/artifactsStore";
import "./ChatContainer.css";

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
  type: "document" | "app";
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

export const ChatContainer: React.FC<ChatContainerProps> = ({ chatId }) => {
  // Combined selector — single subscription instead of three, reduces re-render triggers
  const chatState = useChatStore((state) => state.chatStates.get(chatId));
  const messages = chatState?.messages ?? EMPTY_MESSAGES;
  const chatIsLoading = chatState?.isLoading ?? false;
  const isSending = chatState?.isSending ?? false;

  const error = useChatStore((state) => state.error);

  const { sendMessage } = useAgent();
  const inputBarRef = useRef<InputBarRef>(null);
  const { isModelAvailable, status: authStatus } = useAuthStatus();
  const { ensureModel, progress, installing, status: ollamaStatus } = useOllama();
  const fallbackModel =
    CHAT_MODELS.find((m) => m.id === "claude-sonnet-4-6") || CHAT_MODELS[0];

  const [selectedModel, setSelectedModel] = useState<AIModel>(fallbackModel);
  const [contextInfo, setContextInfo] = useState<unknown | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<{ status: string; message?: string } | null>(null);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const isProcessingQueue = useRef(false);

  // Listen for gateway supervisor status changes (restart notifications)
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { gateway?: { onStatusChange?: (cb: (data: { status: string; message?: string }) => void) => void; removeStatusListener?: () => void } } }).electronAPI;
    if (api?.gateway?.onStatusChange) {
      api.gateway.onStatusChange((data) => {
        setGatewayStatus(data.status === "restarting" ? data : null);
      });
      return () => {
        api.gateway?.removeStatusListener?.();
      };
    }
  }, []);

  // Only block THIS chat if it's waiting for an Ollama model that's currently being installed
  // Don't block on initial load - only block when actively installing/starting
  const isWaitingForModel = selectedModel.provider === 'ollama' && installing === selectedModel.id;

  // When chatId or auth status changes: pick best default
  // Priority: last selected (persisted in localStorage) > default order (sonnet-4-6 → gpt-5.4 → gemini-3-flash) > first available
  useEffect(() => {
    setSelectedModel((prev) => {
      const lastId = useChatStore.getState().getLastSelectedModel(chatId);
      if (lastId) {
        const lastModel = getModelById(lastId);
        if (lastModel && isModelAvailable(lastModel)) return lastModel;
      }
      const defaultAvailable = DEFAULT_MODEL_IDS.map(getModelById).find(
        (m) => m && isModelAvailable(m),
      );
      if (defaultAvailable) return defaultAvailable;
      const firstAvailable = CHAT_MODELS.find((m) => isModelAvailable(m));
      if (firstAvailable) return firstAvailable;
      if (!isModelAvailable(prev)) return fallbackModel;
      return prev;
    });
  }, [chatId, authStatus]);

  // Focus input when this chat's container mounts
  useEffect(() => {
    // Focus after a small delay to ensure DOM is ready
    const timer = setTimeout(() => {
      inputBarRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [chatId]); // Re-focus when chatId changes (different chat loaded)

  // Ensure each visible pane hydrates its own chat history.
  // This fixes split-view startup where right pane could stay empty until tab toggles.
  useEffect(() => {
    let cancelled = false;

    const hydrateHistory = async () => {
      const existingState = useChatStore.getState().chatStates.get(chatId);
      if ((existingState?.messages.length || 0) > 0) {
        return;
      }

      useChatStore.setState((state) => {
        const current = state.chatStates.get(chatId) || { ...defaultChatState };
        const next = new Map(state.chatStates);
        next.set(chatId, {
          ...current,
          isLoading: true,
        });
        return { chatStates: next };
      });

      try {
        const history = await fetchChatHistory(chatId);
        if (cancelled) return;
        const mapped = mapHistoryMessages(history);

        useChatStore.setState((state) => {
          const current = state.chatStates.get(chatId) || {
            ...defaultChatState,
          };
          const next = new Map(state.chatStates);
          next.set(chatId, {
            ...current,
            messages: mapped,
            isLoading: false,
          });
          return { chatStates: next };
        });
      } catch (error) {
        if (!cancelled) {
          console.error(
            `[ChatContainer] Failed to hydrate chat ${chatId}:`,
            error,
          );
        }
      } finally {
        useChatStore.setState((state) => {
          const current = state.chatStates.get(chatId) || {
            ...defaultChatState,
          };
          const next = new Map(state.chatStates);
          next.set(chatId, {
            ...current,
            isLoading: false,
          });
          return { chatStates: next };
        });
      }
    };

    hydrateHistory();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

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
              Math.abs(
                new Date(m.timestamp).getTime() -
                  new Date(incomingMessage.timestamp).getTime(),
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
            await gateway.send("chat:stats", { chatId });
            // The summarize action is primarily for fetching/displaying a summary
            // For now, trigger a stats update
          } catch (err) {
            console.error("[ChatContainer] Summarize error:", err);
          }
          break;
        }
        case "context": {
          try {
            const response = await gateway.send("chat:inspect-context", {
              chatId,
              model: selectedModel.id,
            });
            setContextInfo(response.data);
          } catch (err) {
            console.error("[ChatContainer] Context inspection error:", err);
            alert("Failed to load context information. Check console for details.");
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

  const handleSendMessage = useCallback(
    async (message: string, contextArtifacts?: Artifact[]) => {
      const mergedArtifact = findMergedArtifact(chatId);

      const idKey =
        mergedArtifact?.type === "document" ? "documentId" : "appId";
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
            artifactsContext += `File Path: ${artifact.metadata.filePath}\n`;
            if (artifact.metadata.fileType) {
              artifactsContext += `File Type: ${artifact.metadata.fileType}\n`;
            }
            artifactsContext +=
              "\nThe user attached this file from disk. Read it with the read_file tool using the path above (use encoding: \"base64\" for binary files).\n";
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

      // Send message for THIS chat (not activeChat)
      await sendMessage(message, config, chatId);
    },
    [selectedModel, sendMessage, chatId, ensureModel],
  );

  const handleStopAgent = useCallback(async () => {
    try {
      await gateway.send("agent:stop", { chatId });
      console.log(`[ChatContainer] Stopped agent for chat ${chatId}`);
    } catch (error) {
      console.error("[ChatContainer] Failed to stop agent:", error);
    } finally {
      // Optimistically reset UI immediately so Stop icon returns to Send
      useChatStore.getState().setSending(chatId, false);
      useChatStore.getState().setChatStreaming(chatId, false);
      useTabStore.getState().setTabStreaming(`chat-${chatId}`, false);
      
      // Finalize any streaming message to update its status from "Working" to "Finished Working"
      const chatState = useChatStore.getState().chatStates.get(chatId);
      if (chatState?.messages) {
        const streamingMessage = chatState.messages.find(msg => msg.isStreaming);
        if (streamingMessage) {
          // Update sequence to mark any "calling" tools as stopped
          const updatedSequence = streamingMessage.sequence?.map(item => {
            if (item.type === "tool" && (item.data as any)?.status === "calling") {
              return {
                ...item,
                data: {
                  ...(item.data as any),
                  status: "stopped",
                  error: "Stopped by user"
                }
              };
            }
            return item;
          });
          
          // Update toolCalls to mark any calling tools as stopped
          const updatedToolCalls = streamingMessage.toolCalls?.map(tc => {
            if (tc.status === "calling") {
              return {
                ...tc,
                status: "error" as const,
                error: "Stopped by user"
              };
            }
            return tc;
          });
          
          // Update the message in the store with the modified sequence and toolCalls
          const updatedMessages = chatState.messages.map(msg => 
            msg.id === streamingMessage.id 
              ? { 
                  ...msg, 
                  sequence: updatedSequence,
                  toolCalls: updatedToolCalls 
                }
              : msg
          );
          
          const newChatStates = new Map(useChatStore.getState().chatStates);
          newChatStates.set(chatId, {
            ...chatState,
            messages: updatedMessages
          });
          
          useChatStore.setState({ chatStates: newChatStates });
          
          // Now finalize the streaming message
          useChatStore.getState().finalizeStreamingMessage(streamingMessage.id, chatId);
        }
      }
    }
  }, [chatId]);

  // Queue management handlers
  const handleQueueMessage = useCallback((message: string, context?: Artifact[]) => {
    const queuedMessage: QueuedMessage = {
      id: `queued-${Date.now()}-${Math.random()}`,
      text: message,
      timestamp: Date.now(),
    };
    setMessageQueue(prev => [...prev, queuedMessage]);
  }, []);

  const handleSendQueuedNow = useCallback(async (messageId: string) => {
    const queued = messageQueue.find(q => q.id === messageId);
    if (!queued) return;

    // Remove from queue
    setMessageQueue(prev => prev.filter(q => q.id !== messageId));

    // Stop current agent response
    await handleStopAgent();

    // Send the queued message
    await handleSendMessage(queued.text);
  }, [messageQueue, handleStopAgent, handleSendMessage]);

  const handleRemoveQueued = useCallback((messageId: string) => {
    setMessageQueue(prev => prev.filter(q => q.id !== messageId));
  }, []);

  const processNextQueued = useCallback(async () => {
    if (isProcessingQueue.current || messageQueue.length === 0 || isSending) {
      return;
    }

    isProcessingQueue.current = true;
    const nextMessage = messageQueue[0];
    setMessageQueue(prev => prev.slice(1));

    try {
      await handleSendMessage(nextMessage.text);
    } catch (error) {
      console.error('[ChatContainer] Failed to send queued message:', error);
    } finally {
      isProcessingQueue.current = false;
    }
  }, [messageQueue, isSending, handleSendMessage]);

  // Auto-send next queued message when agent finishes responding
  useEffect(() => {
    if (!isSending && messageQueue.length > 0) {
      processNextQueued();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSending, messageQueue.length]);  // processNextQueued is stable, don't include it

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

  const handleChatDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const { files } = e.dataTransfer;
      if (!files?.length) return;
      handleFilesDroppedToChat(Array.from(files));
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

      {gatewayStatus && (
        <div className="reconnecting-banner">
          <span className="reconnecting-icon">↻</span>
          <span className="reconnecting-message">{gatewayStatus.message || "Reconnecting to Gateway..."}</span>
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
      />

      <QueuedMessages
        queue={messageQueue}
        onSendNow={handleSendQueuedNow}
        onRemove={handleRemoveQueued}
      />

      <InputBar
        ref={inputBarRef}
        chatId={chatId}
        onFileAttachmentsAdded={() => setIsFileDragOver(false)}
        onSend={handleSendMessage}
        onQueue={handleQueueMessage}
        onStop={handleStopAgent}
        onSlashCommand={handleSlashCommand}
        isSending={isSending || isWaitingForModel}
        placeholder={
          (isWaitingForModel 
            ? `Preparing ${selectedModel.name}...` 
            : messageQueue.length > 0
              ? "Send follow-up..." 
              : "Type a message...") as string
        }
        selectedModel={selectedModel}
        onModelChange={handleModelChange}
        isModelAvailable={isModelAvailable}
        onOpenSettings={handleOpenSettings}
      />

      {contextInfo && (
        <ContextInspectorModal
          contextInfo={contextInfo as any}
          onClose={() => setContextInfo(null)}
        />
      )}
    </div>
  );
};
