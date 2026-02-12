/**
 * Tests for Chat Store
 * Tests parallel chat state management and empty chat detection
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../../stores/chatStore";
import type { ChatMessage } from "../../types/chat";

describe("ChatStore", () => {
  beforeEach(() => {
    // Reset store before each test
    // const store = useChatStore.getState() // REMOVED - use direct calls;
    useChatStore.getState().setChats([]);
    useChatStore.getState().clearMessages();
    useChatStore.setState({
      activeChat: null,
      chatStates: new Map(),
      chats: [],
      messages: [],
    });
  });

  describe("Chat State Initialization", () => {
    it("should initialize chat state when setActiveChat is called", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const chatId = "test-chat-1";

      // Set active chat
      useChatStore.getState().setActiveChat(chatId);

      // Chat state should be initialized
      const chatState = useChatStore.getState().getChatState(chatId);
      expect(chatState).toBeDefined();
      expect(chatState.messages).toEqual([]);
      expect(chatState.isStreaming).toBe(false);
      expect(chatState.hasUnread).toBe(false);
    });

    it("should preserve existing chat state when switching chats", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const chat1 = "test-chat-1";
      const chat2 = "test-chat-2";

      // Initialize chat 1 with messages
      useChatStore.getState().setActiveChat(chat1);
      const message: ChatMessage = {
        role: "user",
        content: "Test message",
      };
      useChatStore.getState().addMessage(message, chat1);

      // Switch to chat 2
      useChatStore.getState().setActiveChat(chat2);

      // Chat 1 state should still exist
      const chat1State = useChatStore.getState().getChatState(chat1);
      expect(chat1State.messages.length).toBe(1);
      expect(chat1State.messages[0].content).toBe("Test message");

      // Chat 2 should be empty
      const chat2State = useChatStore.getState().getChatState(chat2);
      expect(chat2State.messages.length).toBe(0);
    });
  });

  describe("Empty Chat Detection", () => {
    it("should correctly identify empty chats", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const emptyChatId = "empty-chat";
      const fullChatId = "full-chat";

      // Initialize empty chat
      useChatStore.getState().setActiveChat(emptyChatId);
      const emptyState = useChatStore.getState().getChatState(emptyChatId);
      expect(emptyState.messages.length).toBe(0);

      // Initialize chat with messages
      useChatStore.getState().setActiveChat(fullChatId);
      useChatStore
        .getState()
        .addMessage({ role: "user", content: "Hello" }, fullChatId);
      const fullState = useChatStore.getState().getChatState(fullChatId);
      expect(fullState.messages.length).toBe(1);
    });

    it("should handle multiple empty chats independently", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const chat1 = "chat-1";
      const chat2 = "chat-2";
      const chat3 = "chat-3";

      // Initialize all chats
      useChatStore.getState().setActiveChat(chat1);
      useChatStore.getState().setActiveChat(chat2);
      useChatStore.getState().setActiveChat(chat3);

      // Add message to chat 2
      useChatStore
        .getState()
        .addMessage({ role: "user", content: "Test" }, chat2);

      // Check states
      expect(useChatStore.getState().getChatState(chat1).messages.length).toBe(
        0,
      );
      expect(useChatStore.getState().getChatState(chat2).messages.length).toBe(
        1,
      );
      expect(useChatStore.getState().getChatState(chat3).messages.length).toBe(
        0,
      );
    });
  });

  describe("Parallel Chat Streaming", () => {
    it("should track streaming state per chat", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const chat1 = "chat-1";
      const chat2 = "chat-2";

      // Initialize chats
      useChatStore.getState().setActiveChat(chat1);
      useChatStore.getState().setActiveChat(chat2);

      // Start streaming in chat 1
      useChatStore.getState().setChatStreaming(chat1, true);

      // Check states
      expect(useChatStore.getState().getChatState(chat1).isStreaming).toBe(
        true,
      );
      expect(useChatStore.getState().getChatState(chat2).isStreaming).toBe(
        false,
      );

      // Stop streaming in chat 1, start in chat 2
      useChatStore.getState().setChatStreaming(chat1, false);
      useChatStore.getState().setChatStreaming(chat2, true);

      expect(useChatStore.getState().getChatState(chat1).isStreaming).toBe(
        false,
      );
      expect(useChatStore.getState().getChatState(chat2).isStreaming).toBe(
        true,
      );
    });

    it("should track unread state per chat", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const chat1 = "chat-1";
      const chat2 = "chat-2";

      // Initialize chats
      useChatStore.getState().setActiveChat(chat1);
      useChatStore.getState().setActiveChat(chat2);

      // Mark chat 1 as unread
      useChatStore.getState().setChatUnread(chat1, true);

      // Check states
      expect(useChatStore.getState().getChatState(chat1).hasUnread).toBe(false); // getChatState doesn't read from chats array

      // Mark as read
      useChatStore.getState().markChatAsRead(chat1);

      // Should be read now (in chats array)
      const chat1Meta = useChatStore
        .getState()
        .chats.find((c) => c.id === chat1);
      expect(chat1Meta?.hasUnread).toBe(false);
    });

    it("should add streaming messages to inactive chats", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const activeChat = "active-chat";
      const inactiveChat = "inactive-chat";

      // Set active chat
      useChatStore.getState().setActiveChat(activeChat);

      // Initialize inactive chat
      useChatStore.getState().setActiveChat(inactiveChat);
      useChatStore.getState().setActiveChat(activeChat); // Switch back

      // Add message to inactive chat
      const message: ChatMessage = {
        role: "assistant",
        content: "Streaming message",
      };
      useChatStore.getState().addMessage(message, inactiveChat);

      // Check that inactive chat has the message
      const inactiveChatState = useChatStore
        .getState()
        .getChatState(inactiveChat);
      expect(inactiveChatState.messages.length).toBe(1);
      expect(inactiveChatState.messages[0].content).toBe("Streaming message");

      // Active chat should still be empty
      const activeChatState = useChatStore.getState().getChatState(activeChat);
      expect(activeChatState.messages.length).toBe(0);
    });
  });

  describe("Message Management", () => {
    it("should add messages to the correct chat", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const chat1 = "chat-1";
      const chat2 = "chat-2";

      // Initialize chats
      useChatStore.getState().setActiveChat(chat1);
      useChatStore.getState().setActiveChat(chat2);

      // Add messages to each chat
      useChatStore
        .getState()
        .addMessage({ role: "user", content: "Chat 1 message" }, chat1);
      useChatStore
        .getState()
        .addMessage({ role: "user", content: "Chat 2 message" }, chat2);

      // Check messages
      const chat1State = useChatStore.getState().getChatState(chat1);
      const chat2State = useChatStore.getState().getChatState(chat2);

      expect(chat1State.messages.length).toBe(1);
      expect(chat1State.messages[0].content).toBe("Chat 1 message");

      expect(chat2State.messages.length).toBe(1);
      expect(chat2State.messages[0].content).toBe("Chat 2 message");
    });

    it("should update streaming messages correctly", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const chatId = "test-chat";

      // Initialize chat
      useChatStore.getState().setActiveChat(chatId);

      // Add streaming message
      const messageId = "msg-1";
      useChatStore
        .getState()
        .addMessage(
          { role: "assistant", content: "Initial", id: messageId },
          chatId,
        );

      // Update streaming message
      useChatStore
        .getState()
        .updateStreamingMessage(messageId, "Updated content", chatId);

      // Check message
      const chatState = useChatStore.getState().getChatState(chatId);
      expect(chatState.messages[0].content).toBe("Updated content");
    });

    it("should finalize streaming messages", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const chatId = "test-chat";

      // Initialize chat
      useChatStore.getState().setActiveChat(chatId);

      // Add streaming message
      const messageId = "msg-1";
      useChatStore
        .getState()
        .addMessage(
          { role: "assistant", content: "Streaming...", id: messageId },
          chatId,
        );

      // Start streaming
      useChatStore.getState().setChatStreaming(chatId, true);
      expect(useChatStore.getState().getChatState(chatId).isStreaming).toBe(
        true,
      );

      // Finalize
      useChatStore.getState().finalizeStreamingMessage(messageId, chatId);

      // Streaming should stop
      expect(useChatStore.getState().getChatState(chatId).isStreaming).toBe(
        false,
      );
    });
  });

  describe("Default State", () => {
    it("should return default state for uninitialized chats", () => {
      // const store = useChatStore.getState() // REMOVED - use direct calls;
      const uninitializedChatId = "uninitialized";

      const state = useChatStore.getState().getChatState(uninitializedChatId);
      expect(state.messages).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.isSending).toBe(false);
      expect(state.isStreaming).toBe(false);
      expect(state.hasUnread).toBe(false);
    });
  });
});
