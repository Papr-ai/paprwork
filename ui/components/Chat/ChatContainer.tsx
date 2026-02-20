/**
 * ChatContainer Component - Main chat interface
 * Brings together MessageList and InputBar with agent integration
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import { MessageList } from "./MessageList";
import { InputBar, InputBarRef } from "./InputBar";
import { useAgent } from "../../hooks/useAgent";
import { useChatStore, defaultChatState } from "../../stores/chatStore";
import { useTabStore } from "../../stores/tabStore";
import type { Tab } from "../../stores/tabStore";
import { CHAT_MODELS } from "../../constants/models";
import type { AIModel } from "../../constants/models";
import { mapHistoryMessages } from "../../utils/historyMapper";
import { fetchChatHistory } from "../../utils/chatHistoryApi";
import { gateway } from "../../src/lib/gateway";
import { JobPermissionBanner } from "./JobPermissionBanner";
import "./ChatContainer.css";

const DEFAULT_SYSTEM_PROMPT = `You're Papr, an AI assistant running in Paprwork—a native Mac AI workspace.

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
You're not in a web chat. You're in a native Mac app with Jobs, Skills, and Mini-apps. Use them.

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

interface ChatContainerProps {
  chatId: string;
}

export const ChatContainer: React.FC<ChatContainerProps> = ({ chatId }) => {
  // Get messages and state for THIS specific chat (not activeChat)
  const messages = useChatStore((state) => {
    const chatState = state.chatStates.get(chatId);
    return chatState?.messages || [];
  });
  const chatIsLoading = useChatStore((state) => {
    const chatState = state.chatStates.get(chatId);
    return chatState?.isLoading || false;
  });
  const isSending = useChatStore((state) => {
    const chatState = state.chatStates.get(chatId);
    return chatState?.isSending || false;
  });

  // Log after getting messages (not inside the selector)
  useEffect(() => {
    const chatState = useChatStore.getState().chatStates.get(chatId);
    console.log(
      `[ChatContainer] Rendering chatId=${chatId}, hasChatState=${!!chatState}, messageCount=${chatState?.messages?.length || 0}`,
    );
  }, [chatId, messages.length]);

  const error = useChatStore((state) => state.error);

  const { sendMessage } = useAgent();
  const inputBarRef = useRef<InputBarRef>(null);

  // Model selection state - default to Claude Sonnet 4.5
  const [selectedModel, setSelectedModel] = useState<AIModel>(
    CHAT_MODELS.find((m) => m.id === "claude-sonnet-4-6") || CHAT_MODELS[0],
  );

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
            const response = await gateway.send("chat:stats", { chatId });
            const stats = response.data as Record<string, unknown>;
            alert(
              `Messages: ${stats.messageCount ?? "N/A"}\nTokens (est): ${stats.tokenCount ?? "N/A"}`,
            );
          } catch (err) {
            console.error("[ChatContainer] Context stats error:", err);
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

  const handleSendMessage = useCallback(
    async (message: string) => {
      const mergedArtifact = findMergedArtifact(chatId);

      const idKey =
        mergedArtifact?.type === "document" ? "documentId" : "appId";
      const mergedContext = mergedArtifact
        ? `\n\n## Active Context\nThe user has merged this chat with a ${mergedArtifact.type} titled "${mergedArtifact.title}" (${idKey}: "${mergedArtifact.id}"). They are viewing and working on this ${mergedArtifact.type} alongside this conversation. Reference it directly when relevant.`
        : "";

      // Create config WITHOUT apiKey - Gateway will fetch it via IPC
      // This keeps keys secure and never sends them over WebSocket
      const config = {
        provider: selectedModel.provider,
        model: selectedModel.id,
        systemPrompt: DEFAULT_SYSTEM_PROMPT + mergedContext,
        reasoning: selectedModel.reasoning,
        thinkingBudget: selectedModel.defaultThinkingBudget,
        maxTokens: selectedModel.maxTokens, // Output token limit
      };

      // Send message for THIS chat (not activeChat)
      await sendMessage(message, config, chatId);
    },
    [selectedModel, sendMessage, chatId],
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
    }
  }, [chatId]);

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

  return (
    <div className="chat-container" data-testid="chat-container">
      {error && (
        <div className="error-banner">
          <span className="error-icon">⚠️</span>
          <span className="error-message">{error}</span>
        </div>
      )}

      <JobPermissionBanner />

      <MessageList
        messages={messages}
        isLoading={chatIsLoading}
        isSending={isSending}
      />

      <InputBar
        ref={inputBarRef}
        chatId={chatId}
        onSend={handleSendMessage}
        onStop={handleStopAgent}
        onSlashCommand={handleSlashCommand}
        isSending={isSending}
        placeholder="Type a message..."
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
      />
    </div>
  );
};
