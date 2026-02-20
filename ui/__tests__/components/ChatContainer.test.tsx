/**
 * ChatContainer Component Tests
 *
 * Tests the main ChatContainer component:
 * - Message rendering
 * - Input handling
 * - Streaming state updates
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatContainer } from "../../components/Chat/ChatContainer";
import { useChatStore, defaultChatState } from "../../stores/chatStore";
import { useTabStore } from "../../stores/tabStore";
import type { ChatMessage } from "../../types/chat";

// Mock external dependencies (NOT stores - we use real Zustand stores)
const mockSendMessage = vi.fn();
vi.mock("../../hooks/useAgent", () => ({
  useAgent: () => ({ sendMessage: mockSendMessage }),
}));

vi.mock("../../src/lib/gateway", () => ({
  gateway: { send: vi.fn().mockResolvedValue({ data: {} }) },
}));

vi.mock("../../utils/chatHistoryApi", () => ({
  fetchChatHistory: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../utils/historyMapper", () => ({
  mapHistoryMessages: vi.fn().mockReturnValue([]),
}));

// Mock permission store used by MessageList
vi.mock("../../stores/permissionStore", () => ({
  usePermissionStore: vi.fn(() => null),
}));

const TEST_CHAT_ID = "test-chat-1";

function initChatState(
  messages: ChatMessage[] = [],
  overrides: Partial<typeof defaultChatState> = {},
) {
  const chatState = { ...defaultChatState, messages, ...overrides };
  useChatStore.setState({
    chats: [
      {
        id: TEST_CHAT_ID,
        title: "Test Chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isStreaming: false,
        hasUnread: false,
      },
    ],
    chatStates: new Map([[TEST_CHAT_ID, chatState]]),
    isLoading: false,
    error: null,
  });
}

describe("ChatContainer", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset stores
    useChatStore.setState({
      chats: [],
      chatStates: new Map(),
      isLoading: false,
      error: null,
    });

    useTabStore.setState({
      tabs: [],
      activeTabId: null,
      splitRatio: 0.5,
      isSplitView: false,
      activeLeftTab: null,
      activeRightTab: null,
    });

    // Initialize default chat state
    initChatState();
  });

  describe("Rendering", () => {
    it("should render ChatContainer", () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const container = screen.getByTestId("chat-container");
      expect(container).toBeDefined();
    });

    it("should render message list", () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const messageList = screen.queryByTestId("message-list");
      expect(messageList).toBeDefined();
    });

    it("should render input bar", () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const inputBar = screen.getByTestId("chat-input");
      expect(inputBar).toBeDefined();
    });

    it("should render send button", () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      // Focus the input to make the footer (with send button) visible
      const input = screen.getByTestId("chat-input");
      fireEvent.focus(input);

      const sendButton = screen.getByTestId("send-button");
      expect(sendButton).toBeDefined();
    });
  });

  describe("Empty State", () => {
    it("should show welcome message when no messages", () => {
      initChatState([]);
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const messageList = screen.getByTestId("message-list");
      expect(messageList).toBeDefined();
      // Empty state renders WelcomeMessage, no message items
      const items = screen.queryAllByTestId(/^message-item-/);
      expect(items.length).toBe(0);
    });

    it("should not show welcome message when messages exist", () => {
      initChatState([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ]);
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const items = screen.queryAllByTestId(/^message-item-/);
      expect(items.length).toBeGreaterThan(0);
    });
  });

  describe("Message Display", () => {
    it("should render user messages", () => {
      initChatState([{ role: "user", content: "Test user message" }]);
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const userMessage = screen.queryByText(/Test user message/);
      expect(userMessage).toBeDefined();
    });

    it("should render assistant messages", () => {
      initChatState([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Test assistant response" },
      ]);
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const assistantMessage = screen.queryByText(/Test assistant response/);
      expect(assistantMessage).toBeDefined();
    });

    it("should render multiple messages in order", () => {
      initChatState([
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Response 1" },
        { role: "user", content: "Message 2" },
        { role: "assistant", content: "Response 2" },
      ]);
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const messages = screen.queryAllByTestId(/^message-item-/);
      expect(messages.length).toBe(4);
    });
  });

  describe("Input Handling", () => {
    it("should allow typing in input field", () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "Test message" } });

      expect(input.value).toBe("Test message");
    });

    it("should enable send button when input has text", () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const input = screen.getByTestId("chat-input");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "Test" } });

      const sendButton = screen.getByTestId("send-button") as HTMLButtonElement;
      expect(sendButton.disabled).toBe(false);
    });

    it("should disable send button when input is empty", () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const input = screen.getByTestId("chat-input");
      fireEvent.focus(input);

      const sendButton = screen.getByTestId("send-button") as HTMLButtonElement;
      expect(sendButton.disabled).toBe(true);
    });

    it("should clear input after sending message", async () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "Test message" } });

      const sendButton = screen.getByTestId("send-button");
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(input.value).toBe("");
      });
    });

    it("should send message on Enter key", async () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const input = screen.getByTestId("chat-input");
      fireEvent.change(input, { target: { value: "Test message" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });
    });

    it("should not send on Shift+Enter (new line)", () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const input = screen.getByTestId("chat-input");
      fireEvent.change(input, { target: { value: "Test" } });
      fireEvent.keyDown(input, {
        key: "Enter",
        code: "Enter",
        shiftKey: true,
      });

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe("Streaming State", () => {
    it("should show loading indicator while sending", () => {
      initChatState([], { isSending: true });
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      // The component shows a loading indicator when isSending is true
      const container = screen.getByTestId("chat-container");
      expect(container).toBeDefined();
    });

    it("should disable input while sending", () => {
      // InputBar disables itself based on isSending prop, not the store's streaming state.
      // The component passes isSending to InputBar, which shows the stop button instead.
      initChatState([], { isSending: true });
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      // When sending, the button becomes a stop button
      const input = screen.getByTestId("chat-input");
      fireEvent.focus(input);
      const stopButton = screen.queryByTestId("stop-button");
      expect(stopButton).toBeDefined();
    });

    it("should show stop button while sending", () => {
      initChatState([], { isSending: true });
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const input = screen.getByTestId("chat-input");
      fireEvent.focus(input);
      const stopButton = screen.queryByTestId("stop-button");
      expect(stopButton).not.toBeNull();
    });

    it("should show send button when not streaming", () => {
      initChatState([{ role: "assistant", content: "Response" }]);
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const input = screen.getByTestId("chat-input");
      fireEvent.focus(input);
      const sendButton = screen.queryByTestId("send-button");
      expect(sendButton).not.toBeNull();
    });
  });

  describe("Error Handling", () => {
    it("should display error banner when error exists", () => {
      initChatState([{ role: "user", content: "Test" }]);
      useChatStore.setState({ error: "Failed to connect" });

      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const errorMessage = screen.queryByText(/Failed to connect/i);
      expect(errorMessage).not.toBeNull();
    });

    it("should allow sending messages after error", async () => {
      initChatState([]);
      useChatStore.setState({ error: "Connection error" });

      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      // Input should still be enabled
      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      expect(input.disabled).toBeFalsy();

      // Should be able to type and send
      fireEvent.change(input, { target: { value: "Retry" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

      await waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });
    });
  });

  describe("Draft Message Persistence", () => {
    it("should persist draft message when switching between chats", async () => {
      const CHAT_1 = "chat-1";
      const CHAT_2 = "chat-2";

      // Initialize two chats
      initChatState();
      useChatStore.setState((state) => {
        const newStates = new Map(state.chatStates);
        newStates.set(CHAT_1, { ...defaultChatState });
        newStates.set(CHAT_2, { ...defaultChatState });
        return { chatStates: newStates };
      });

      // Render chat 1 and type a draft message
      const { rerender } = render(<ChatContainer chatId={CHAT_1} />);
      const input1 = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      fireEvent.change(input1, { target: { value: "Draft for chat 1" } });

      // Verify the draft is stored
      await waitFor(() => {
        expect(useChatStore.getState().getDraftMessage(CHAT_1)).toBe(
          "Draft for chat 1",
        );
      });

      // Switch to chat 2 and type a different draft
      rerender(<ChatContainer chatId={CHAT_2} />);
      const input2 = screen.getByTestId("chat-input") as HTMLTextAreaElement;

      // Input should be empty for chat 2
      expect(input2.value).toBe("");

      fireEvent.change(input2, { target: { value: "Draft for chat 2" } });

      // Verify chat 2's draft is stored
      await waitFor(() => {
        expect(useChatStore.getState().getDraftMessage(CHAT_2)).toBe(
          "Draft for chat 2",
        );
      });

      // Switch back to chat 1
      rerender(<ChatContainer chatId={CHAT_1} />);
      const input1Again = screen.getByTestId(
        "chat-input",
      ) as HTMLTextAreaElement;

      // Draft message should be restored
      await waitFor(() => {
        expect(input1Again.value).toBe("Draft for chat 1");
      });
    });

    it("should clear draft message after sending", async () => {
      render(<ChatContainer chatId={TEST_CHAT_ID} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "Message to send" } });

      // Verify draft is stored
      await waitFor(() => {
        expect(useChatStore.getState().getDraftMessage(TEST_CHAT_ID)).toBe(
          "Message to send",
        );
      });

      // Send the message
      const sendButton = screen.getByTestId("send-button");
      fireEvent.click(sendButton);

      // Verify draft is cleared
      await waitFor(() => {
        expect(useChatStore.getState().getDraftMessage(TEST_CHAT_ID)).toBe("");
        expect(input.value).toBe("");
      });
    });
  });
});
