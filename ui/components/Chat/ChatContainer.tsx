/**
 * ChatContainer Component - Main chat interface
 * Brings together MessageList and InputBar with agent integration
 */

import React, { useState, useRef, useEffect } from "react";
import { MessageList } from "./MessageList";
import { InputBar, InputBarRef } from "./InputBar";
import { useAgent } from "../../hooks/useAgent";
import { useChatStore } from "../../stores/chatStore";
import { CHAT_MODELS } from "../../constants/models";
import type { AIModel } from "../../constants/models";
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

interface ChatContainerProps {
  chatId: string;
}

export const ChatContainer: React.FC<ChatContainerProps> = ({ chatId }) => {
  // Get messages and state for THIS specific chat (not activeChat)
  const messages = useChatStore((state) => {
    const chatState = state.chatStates.get(chatId);
    return chatState?.messages || [];
  });
  
  // Log after getting messages (not inside the selector)
  useEffect(() => {
    const chatState = useChatStore.getState().chatStates.get(chatId);
    console.log(`[ChatContainer] Rendering chatId=${chatId}:`, {
      hasChatState: !!chatState,
      messageCount: chatState?.messages?.length || 0,
    });
  }, [chatId, messages.length]);

  const isSending = useChatStore((state) => {
    const chatState = state.chatStates.get(chatId);
    return chatState?.isSending || false;
  });

  const isLoading = useChatStore((state) => state.isLoading);
  const error = useChatStore((state) => state.error);
  
  const { sendMessage } = useAgent();
  const inputBarRef = useRef<InputBarRef>(null);
  
  // Model selection state - default to Claude Sonnet 4.5
  const [selectedModel, setSelectedModel] = useState<AIModel>(
    CHAT_MODELS.find((m) => m.id === "claude-sonnet-4-5") || CHAT_MODELS[0]
  );

  // Focus input when this chat's container mounts
  useEffect(() => {
    // Focus after a small delay to ensure DOM is ready
    const timer = setTimeout(() => {
      inputBarRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [chatId]); // Re-focus when chatId changes (different chat loaded)

  const handleSendMessage = async (message: string) => {
    // Create config WITHOUT apiKey - Gateway will fetch it via IPC
    // This keeps keys secure and never sends them over WebSocket
    const config = {
      provider: selectedModel.provider,
      model: selectedModel.id,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      reasoning: selectedModel.reasoning,
    };

    // Send message for THIS chat (not activeChat)
    await sendMessage(message, config, chatId);
  };

  return (
    <div className="chat-container">
      {error && (
        <div className="error-banner">
          <span className="error-icon">⚠️</span>
          <span className="error-message">{error}</span>
        </div>
      )}

      <MessageList messages={messages} isLoading={isLoading} />

      <InputBar
        ref={inputBarRef}
        onSend={handleSendMessage}
        disabled={isSending}
        placeholder={isSending ? "Sending..." : "Type a message..."}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
      />
    </div>
  );
};
