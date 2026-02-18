/**
 * Chat Metadata Tests
 *
 * Tests how chat metadata is managed in the store:
 * - setChats populates metadata correctly
 * - Metadata structure has all required fields
 * - setChatUnread / markChatAsRead modify metadata
 * - setChatStreaming syncs to metadata
 * - finalizeStreamingMessage clears streaming flag in metadata
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore, defaultChatState } from "../../stores/chatStore";
import type { ChatMetadata } from "../../types/chat";

/** Build a ChatMetadata entry with sensible defaults */
function makeMeta(id: string, overrides: Partial<ChatMetadata> = {}): ChatMetadata {
  const now = new Date().toISOString();
  return {
    id,
    title: "New Chat",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    isStreaming: false,
    hasUnread: false,
    ...overrides,
  };
}

describe("Chat Metadata", () => {
  beforeEach(() => {
    useChatStore.setState({
      chats: [],
      chatStates: new Map(),
      isLoading: false,
      error: null,
    });
  });

  // ── setChats ────────────────────────────────────────────────────

  describe("setChats", () => {
    it("should store chat metadata from setChats", () => {
      const meta = makeMeta("chat-1", { title: "My Chat" });
      useChatStore.getState().setChats([meta]);

      const chats = useChatStore.getState().chats;
      expect(chats).toHaveLength(1);
      expect(chats[0].id).toBe("chat-1");
      expect(chats[0].title).toBe("My Chat");
    });

    it("should replace all metadata on subsequent setChats calls", () => {
      useChatStore.getState().setChats([makeMeta("a"), makeMeta("b")]);
      expect(useChatStore.getState().chats).toHaveLength(2);

      useChatStore.getState().setChats([makeMeta("c")]);
      expect(useChatStore.getState().chats).toHaveLength(1);
      expect(useChatStore.getState().chats[0].id).toBe("c");
    });
  });

  // ── Metadata Structure ──────────────────────────────────────────

  describe("Metadata Structure", () => {
    it("should include all required fields", () => {
      const meta = makeMeta("chat-1");
      useChatStore.getState().setChats([meta]);

      const chat = useChatStore.getState().chats[0];
      expect(chat).toHaveProperty("id");
      expect(chat).toHaveProperty("title");
      expect(chat).toHaveProperty("createdAt");
      expect(chat).toHaveProperty("updatedAt");
      expect(chat).toHaveProperty("isStreaming");
      expect(chat).toHaveProperty("hasUnread");
    });

    it("should have valid ISO timestamp strings", () => {
      const meta = makeMeta("chat-1");
      useChatStore.getState().setChats([meta]);

      const chat = useChatStore.getState().chats[0];
      expect(chat.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(chat.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      expect(new Date(chat.createdAt).toString()).not.toBe("Invalid Date");
      expect(new Date(chat.updatedAt).toString()).not.toBe("Invalid Date");
    });

    it("should initialize with correct default values", () => {
      const meta = makeMeta("chat-1");
      useChatStore.getState().setChats([meta]);

      const chat = useChatStore.getState().chats[0];
      expect(chat.isStreaming).toBe(false);
      expect(chat.hasUnread).toBe(false);
    });
  });

  // ── Unread / Read ───────────────────────────────────────────────

  describe("Unread / Read", () => {
    it("should mark a chat as unread", () => {
      useChatStore.getState().setChats([makeMeta("chat-1")]);

      useChatStore.getState().setChatUnread("chat-1", true);

      expect(useChatStore.getState().chats[0].hasUnread).toBe(true);
    });

    it("should mark a chat as read", () => {
      useChatStore.getState().setChats([makeMeta("chat-1", { hasUnread: true })]);

      useChatStore.getState().markChatAsRead("chat-1");

      expect(useChatStore.getState().chats[0].hasUnread).toBe(false);
    });

    it("should not affect other chats when marking one as unread", () => {
      useChatStore.getState().setChats([makeMeta("a"), makeMeta("b")]);

      useChatStore.getState().setChatUnread("a", true);

      expect(useChatStore.getState().chats.find((c) => c.id === "a")?.hasUnread).toBe(true);
      expect(useChatStore.getState().chats.find((c) => c.id === "b")?.hasUnread).toBe(false);
    });
  });

  // ── Streaming Synced to Metadata ────────────────────────────────

  describe("Streaming Synced to Metadata", () => {
    it("should set isStreaming on metadata via setChatStreaming", () => {
      useChatStore.getState().setChats([makeMeta("chat-1")]);
      useChatStore.setState((s) => {
        const next = new Map(s.chatStates);
        next.set("chat-1", { ...defaultChatState });
        return { chatStates: next };
      });

      useChatStore.getState().setChatStreaming("chat-1", true);

      expect(useChatStore.getState().chats[0].isStreaming).toBe(true);
    });

    it("should clear isStreaming on metadata via finalizeStreamingMessage", () => {
      useChatStore.getState().setChats([makeMeta("chat-1", { isStreaming: true })]);
      useChatStore.setState((s) => {
        const next = new Map(s.chatStates);
        next.set("chat-1", {
          ...defaultChatState,
          isStreaming: true,
          messages: [{ id: "m1", role: "assistant", content: "", isStreaming: true, streamingContent: "Final" }],
        });
        return { chatStates: next };
      });

      useChatStore.getState().finalizeStreamingMessage("m1", "chat-1");

      expect(useChatStore.getState().chats[0].isStreaming).toBe(false);
    });
  });
});
