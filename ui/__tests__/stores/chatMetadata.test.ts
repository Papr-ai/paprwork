/**
 * Chat Metadata Tests
 * Verifies that chat metadata is created with proper timestamps and structure
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../../stores/chatStore";

describe("Chat Metadata", () => {
  beforeEach(() => {
    useChatStore.setState({
      chats: [],
      activeChat: null,
      messages: [],
      chatStates: new Map(),
      error: null,
    });
  });

  describe("Timestamp Generation", () => {
    it("should create chat metadata with createdAt timestamp", () => {
      const chatId = "test-chat-1";
      useChatStore.getState().setActiveChat(chatId);

      const chat = useChatStore.getState().chats.find((c) => c.id === chatId);
      expect(chat).toBeDefined();
      expect(chat?.createdAt).toBeDefined();
      expect(chat?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    });

    it("should create chat metadata with updatedAt timestamp", () => {
      const chatId = "test-chat-2";
      useChatStore.getState().setActiveChat(chatId);

      const chat = useChatStore.getState().chats.find((c) => c.id === chatId);
      expect(chat).toBeDefined();
      expect(chat?.updatedAt).toBeDefined();
      expect(chat?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    });

    it("should create valid Date objects from timestamps", () => {
      const chatId = "test-chat-3";
      useChatStore.getState().setActiveChat(chatId);

      const chat = useChatStore.getState().chats.find((c) => c.id === chatId);
      expect(chat).toBeDefined();

      // Verify timestamps are valid dates
      const createdDate = new Date(chat!.createdAt);
      const updatedDate = new Date(chat!.updatedAt);

      expect(createdDate.toString()).not.toBe("Invalid Date");
      expect(updatedDate.toString()).not.toBe("Invalid Date");
    });

    it("should not show 'Invalid Date' in UI components", () => {
      const chatId = "test-chat-4";
      useChatStore.getState().setActiveChat(chatId);

      const chat = useChatStore.getState().chats.find((c) => c.id === chatId);
      expect(chat).toBeDefined();

      // Verify dates can be formatted without showing "Invalid Date"
      const formattedDate = new Date(chat!.createdAt).toLocaleDateString();
      expect(formattedDate).not.toContain("Invalid");
    });
  });

  describe("Chat Metadata Structure", () => {
    it("should include all required fields", () => {
      const chatId = "test-chat-5";
      useChatStore.getState().setActiveChat(chatId);

      const chat = useChatStore.getState().chats.find((c) => c.id === chatId);
      expect(chat).toBeDefined();
      expect(chat).toHaveProperty("id");
      expect(chat).toHaveProperty("title");
      expect(chat).toHaveProperty("createdAt");
      expect(chat).toHaveProperty("updatedAt");
      expect(chat).toHaveProperty("isStreaming");
      expect(chat).toHaveProperty("hasUnread");
    });

    it("should initialize with correct default values", () => {
      const chatId = "test-chat-6";
      useChatStore.getState().setActiveChat(chatId);

      const chat = useChatStore.getState().chats.find((c) => c.id === chatId);
      expect(chat?.id).toBe(chatId);
      expect(chat?.title).toBe("New Chat");
      expect(chat?.isStreaming).toBe(false);
      expect(chat?.hasUnread).toBe(false);
    });
  });

  describe("Temp Chat IDs", () => {
    it("should create metadata for temp chat IDs", () => {
      const tempChatId = "temp-123-abc";
      useChatStore.getState().setActiveChat(tempChatId);

      const chat = useChatStore
        .getState()
        .chats.find((c) => c.id === tempChatId);
      expect(chat).toBeDefined();
      expect(chat?.createdAt).toBeDefined();
      expect(chat?.updatedAt).toBeDefined();
    });

    it("should not duplicate metadata for same chat ID", () => {
      const chatId = "test-chat-7";
      useChatStore.getState().setActiveChat(chatId);
      useChatStore.getState().setActiveChat(chatId); // Call twice

      const matchingChats = useChatStore
        .getState()
        .chats.filter((c) => c.id === chatId);
      expect(matchingChats.length).toBe(1);
    });
  });
});
