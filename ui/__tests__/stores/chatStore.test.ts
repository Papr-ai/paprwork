/**
 * Chat Store Tests
 *
 * Tests the per-chat state management features:
 * - Per-chat message management (addMessage with chatId)
 * - Streaming message lifecycle (add → update → finalize)
 * - Parallel chat state isolation
 * - Per-chat streaming & sending states
 * - Default state for uninitialized chats
 * - Global error/loading state
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore, defaultChatState } from "../../stores/chatStore";
import type { ChatMessage, ChatState, ChatMetadata } from "../../types/chat";

/** Helper: initialize a chat's per-chat state in the store */
function initChat(chatId: string, overrides: Partial<ChatState> = {}) {
  const chatState: ChatState = { ...defaultChatState, ...overrides };
  useChatStore.setState((state) => {
    const next = new Map(state.chatStates);
    next.set(chatId, chatState);
    return { chatStates: next };
  });
}

/** Helper: build a minimal ChatMetadata entry */
function makeMeta(id: string, overrides: Partial<ChatMetadata> = {}): ChatMetadata {
  return {
    id,
    title: "Chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 0,
    isStreaming: false,
    hasUnread: false,
    ...overrides,
  };
}

describe("ChatStore", () => {
  beforeEach(() => {
    useChatStore.setState({
      chats: [],
      chatStates: new Map(),
      isLoading: false,
      error: null,
    });
  });

  // ── Per-Chat Message Management ─────────────────────────────────

  describe("Per-Chat Message Management", () => {
    it("should add a message to a specific chat", () => {
      initChat("chat-1");

      const msg: ChatMessage = { id: "m1", role: "user", content: "Hello" };
      useChatStore.getState().addMessage(msg, "chat-1");

      const state = useChatStore.getState().getChatState("chat-1");
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toBe("Hello");
    });

    it("should keep messages isolated between chats", () => {
      initChat("chat-1");
      initChat("chat-2");

      useChatStore.getState().addMessage(
        { id: "m1", role: "user", content: "Chat 1 message" },
        "chat-1",
      );
      useChatStore.getState().addMessage(
        { id: "m2", role: "user", content: "Chat 2 message" },
        "chat-2",
      );

      expect(useChatStore.getState().getChatState("chat-1").messages).toHaveLength(1);
      expect(useChatStore.getState().getChatState("chat-1").messages[0].content).toBe("Chat 1 message");

      expect(useChatStore.getState().getChatState("chat-2").messages).toHaveLength(1);
      expect(useChatStore.getState().getChatState("chat-2").messages[0].content).toBe("Chat 2 message");
    });

    it("should auto-create chat state when adding message to unknown chatId", () => {
      // addMessage lazily creates a chatState entry if one doesn't exist
      useChatStore.getState().addMessage(
        { id: "m1", role: "user", content: "First message" },
        "new-chat",
      );

      const state = useChatStore.getState().getChatState("new-chat");
      expect(state.messages).toHaveLength(1);
    });

    it("should ignore addMessage when no chatId is provided", () => {
      useChatStore.getState().addMessage({ id: "m1", role: "user", content: "No chat" });

      // No chat states should have been created/modified
      expect(useChatStore.getState().chatStates.size).toBe(0);
    });
  });

  // ── Streaming Message Lifecycle ─────────────────────────────────

  describe("Streaming Message Lifecycle", () => {
    it("should update streaming message content", () => {
      initChat("chat-1");
      useChatStore.getState().addMessage(
        { id: "msg-1", role: "assistant", content: "Initial" },
        "chat-1",
      );

      useChatStore.getState().updateStreamingMessage("msg-1", "Updated content", "chat-1");

      const state = useChatStore.getState().getChatState("chat-1");
      expect(state.messages[0].content).toBe("Updated content");
      expect(state.messages[0].isStreaming).toBe(true);
      expect(state.isStreaming).toBe(true);
    });

    it("should finalize a streaming message", () => {
      initChat("chat-1");
      useChatStore.getState().addMessage(
        { id: "msg-1", role: "assistant", content: "" },
        "chat-1",
      );
      useChatStore.getState().updateStreamingMessage("msg-1", "Final content", "chat-1");
      useChatStore.getState().finalizeStreamingMessage("msg-1", "chat-1");

      const state = useChatStore.getState().getChatState("chat-1");
      expect(state.messages[0].isStreaming).toBe(false);
      expect(state.messages[0].streamingContent).toBeUndefined();
      expect(state.isStreaming).toBe(false);
    });

    it("should not modify other messages when updating one", () => {
      initChat("chat-1");
      useChatStore.getState().addMessage({ id: "m1", role: "user", content: "User msg" }, "chat-1");
      useChatStore.getState().addMessage({ id: "m2", role: "assistant", content: "" }, "chat-1");

      useChatStore.getState().updateStreamingMessage("m2", "Streaming...", "chat-1");

      const state = useChatStore.getState().getChatState("chat-1");
      expect(state.messages[0].content).toBe("User msg");
      expect(state.messages[0].isStreaming).toBeUndefined();
      expect(state.messages[1].content).toBe("Streaming...");
      expect(state.messages[1].isStreaming).toBe(true);
    });

    it("should be a no-op when messageId does not exist", () => {
      initChat("chat-1");
      useChatStore.getState().addMessage({ id: "m1", role: "user", content: "Hello" }, "chat-1");

      useChatStore.getState().updateStreamingMessage("nonexistent", "test", "chat-1");

      const state = useChatStore.getState().getChatState("chat-1");
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toBe("Hello");
    });
  });

  // ── Per-Chat Streaming State ────────────────────────────────────

  describe("Per-Chat Streaming State", () => {
    it("should track streaming state independently per chat", () => {
      initChat("chat-1");
      initChat("chat-2");

      useChatStore.getState().setChatStreaming("chat-1", true);

      expect(useChatStore.getState().getChatState("chat-1").isStreaming).toBe(true);
      expect(useChatStore.getState().getChatState("chat-2").isStreaming).toBe(false);
    });

    it("should toggle streaming on and off", () => {
      initChat("chat-1");

      useChatStore.getState().setChatStreaming("chat-1", true);
      expect(useChatStore.getState().getChatState("chat-1").isStreaming).toBe(true);

      useChatStore.getState().setChatStreaming("chat-1", false);
      expect(useChatStore.getState().getChatState("chat-1").isStreaming).toBe(false);
    });

    it("should also update the chats metadata array", () => {
      useChatStore.setState({ chats: [makeMeta("chat-1")] });
      initChat("chat-1");

      useChatStore.getState().setChatStreaming("chat-1", true);

      const meta = useChatStore.getState().chats.find((c) => c.id === "chat-1");
      expect(meta?.isStreaming).toBe(true);
    });
  });

  // ── Per-Chat Sending State ──────────────────────────────────────

  describe("Per-Chat Sending State", () => {
    it("should set sending state for a specific chat", () => {
      initChat("chat-1");

      useChatStore.getState().setSending("chat-1", true);
      expect(useChatStore.getState().getChatState("chat-1").isSending).toBe(true);

      useChatStore.getState().setSending("chat-1", false);
      expect(useChatStore.getState().getChatState("chat-1").isSending).toBe(false);
    });

    it("should not affect other chats' sending state", () => {
      initChat("chat-1");
      initChat("chat-2");

      useChatStore.getState().setSending("chat-1", true);

      expect(useChatStore.getState().getChatState("chat-1").isSending).toBe(true);
      expect(useChatStore.getState().getChatState("chat-2").isSending).toBe(false);
    });
  });

  // ── Unread & Read State ─────────────────────────────────────────

  describe("Unread & Read State", () => {
    it("should mark a chat as unread in metadata", () => {
      useChatStore.setState({ chats: [makeMeta("chat-1")] });

      useChatStore.getState().setChatUnread("chat-1", true);

      const meta = useChatStore.getState().chats.find((c) => c.id === "chat-1");
      expect(meta?.hasUnread).toBe(true);
    });

    it("should mark a chat as read in metadata", () => {
      useChatStore.setState({ chats: [makeMeta("chat-1", { hasUnread: true })] });

      useChatStore.getState().markChatAsRead("chat-1");

      const meta = useChatStore.getState().chats.find((c) => c.id === "chat-1");
      expect(meta?.hasUnread).toBe(false);
    });
  });

  // ── Default / Uninitialized Chat State ──────────────────────────

  describe("Default State", () => {
    it("should return default state for an uninitialized chatId", () => {
      const state = useChatStore.getState().getChatState("unknown-chat");

      expect(state.messages).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.isSending).toBe(false);
      expect(state.isStreaming).toBe(false);
      expect(state.hasUnread).toBe(false);
    });

    it("should return separate default objects for different unknown chats", () => {
      const a = useChatStore.getState().getChatState("a");
      const b = useChatStore.getState().getChatState("b");

      // Equal values but different references
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });
  });

  // ── Global State ────────────────────────────────────────────────

  describe("Global State", () => {
    it("should set and clear global loading", () => {
      useChatStore.getState().setLoading(true);
      expect(useChatStore.getState().isLoading).toBe(true);

      useChatStore.getState().setLoading(false);
      expect(useChatStore.getState().isLoading).toBe(false);
    });

    it("should set and clear global error", () => {
      useChatStore.getState().setError("Something broke");
      expect(useChatStore.getState().error).toBe("Something broke");

      useChatStore.getState().setError(null);
      expect(useChatStore.getState().error).toBeNull();
    });

    it("should replace all chat metadata with setChats", () => {
      useChatStore.getState().setChats([makeMeta("c1"), makeMeta("c2")]);

      expect(useChatStore.getState().chats).toHaveLength(2);
      expect(useChatStore.getState().chats[0].id).toBe("c1");
    });
  });
});
