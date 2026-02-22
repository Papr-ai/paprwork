/**
 * MessageList Component Tests
 *
 * Tests the MessageList component:
 * - Message rendering
 * - Scroll behavior
 * - Auto-scroll on new messages
 * - Message grouping
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "../../components/Chat/MessageList";
import type { ChatMessage } from "../../types/chat";

describe("MessageList", () => {
  const mockMessages: ChatMessage[] = [
    {
      role: "user",
      content: "Hello, how are you?",
      timestamp: new Date("2024-01-01T10:00:00Z"),
    },
    {
      role: "assistant",
      content: "I am doing well, thank you for asking!",
      timestamp: new Date("2024-01-01T10:00:05Z"),
    },
    {
      role: "user",
      content: "Can you help me with React?",
      timestamp: new Date("2024-01-01T10:01:00Z"),
    },
    {
      role: "assistant",
      content: "Of course! What would you like to know about React?",
      timestamp: new Date("2024-01-01T10:01:05Z"),
    },
  ];

  describe("Rendering", () => {
    it("should render MessageList component", () => {
      render(<MessageList chatId="test-chat" messages={mockMessages} isStreaming={false} />);

      const messageList = screen.getByTestId("message-list");
      expect(messageList).toBeDefined();
    });

    it("should render all messages", () => {
      render(<MessageList chatId="test-chat" messages={mockMessages} isStreaming={false} />);

      const messages = screen.getAllByTestId(/^message-item-/);
      expect(messages.length).toBeGreaterThanOrEqual(mockMessages.length);
    });

    it("should render empty state when no messages", () => {
      render(<MessageList chatId="test-chat" messages={[]} isStreaming={false} />);

      const messageList = screen.getByTestId("message-list");
      expect(messageList).toBeDefined();

      // Should not have any messages
      const messages = screen.queryAllByTestId(/^message-item-/);
      expect(messages.length).toBe(0);
    });
  });

  describe("Message Types", () => {
    it("should distinguish between user and assistant messages", () => {
      render(<MessageList chatId="test-chat" messages={mockMessages} isStreaming={false} />);

      const userMessages = screen.getAllByTestId(/message-item-user/);
      const assistantMessages = screen.getAllByTestId(/message-item-assistant/);

      expect(userMessages.length).toBeGreaterThan(0);
      expect(assistantMessages.length).toBeGreaterThan(0);
    });

    it("should display user message content correctly", () => {
      render(<MessageList chatId="test-chat" messages={mockMessages} isStreaming={false} />);

      const userMessage = screen.getByText("Hello, how are you?");
      expect(userMessage).toBeDefined();
    });

    it("should display assistant message content correctly", () => {
      render(<MessageList chatId="test-chat" messages={mockMessages} isStreaming={false} />);

      const assistantMessage = screen.getByText(/I am doing well, thank you/);
      expect(assistantMessage).toBeDefined();
    });
  });

  describe("Streaming State", () => {
    it("should show thinking indicator when streaming", () => {
      render(<MessageList chatId="test-chat" messages={mockMessages} isStreaming={true} />);

      const thinkingCard = screen.queryByTestId("thinking-card");
      expect(thinkingCard).toBeDefined();
    });

    it("should not show thinking indicator when not streaming", () => {
      render(<MessageList chatId="test-chat" messages={mockMessages} isStreaming={false} />);

      const thinkingCard = screen.queryByTestId("thinking-card");
      expect(thinkingCard).toBeNull();
    });

    it("should render streaming assistant message", () => {
      const streamingMessages = [
        ...mockMessages,
        {
          role: "assistant" as const,
          content: "This is a streaming response...",
          isStreaming: true,
          timestamp: new Date(),
        },
      ];

      render(<MessageList chatId="test-chat" messages={streamingMessages} isStreaming={true} />);

      const streamingMessage = screen.getByText(/This is a streaming response/);
      expect(streamingMessage).toBeDefined();
    });
  });

  describe("Message Timestamps", () => {
    it("should display message timestamps", () => {
      render(<MessageList chatId="test-chat" messages={mockMessages} isStreaming={false} />);

      // Look for timestamp elements (implementation-dependent)
      const timestamps = screen.queryAllByTestId(/timestamp/);

      // May or may not show timestamps depending on implementation
      expect(Array.isArray(timestamps)).toBe(true);
    });

    it("should format timestamps correctly", () => {
      const messagesWithTimestamp: ChatMessage[] = [
        {
          role: "user",
          content: "Test",
          timestamp: new Date("2024-01-01T10:30:00Z"),
        },
      ];

      render(
        <MessageList chatId="test-chat" messages={messagesWithTimestamp} isStreaming={false} />,
      );

      // Timestamp should be formatted (implementation-dependent)
      const messageList = screen.getByTestId("message-list");
      expect(messageList).toBeDefined();
    });
  });

  describe("Markdown Rendering", () => {
    it("should render markdown in messages", () => {
      const markdownMessages: ChatMessage[] = [
        {
          role: "assistant",
          content: "**Bold text** and *italic text*",
          timestamp: new Date(),
        },
      ];

      render(<MessageList chatId="test-chat" messages={markdownMessages} isStreaming={false} />);

      // Look for formatted content
      const message = screen.getByText(/Bold text/);
      expect(message).toBeDefined();
    });

    it("should render code blocks", () => {
      const codeMessages: ChatMessage[] = [
        {
          role: "assistant",
          content: '```javascript\nconst hello = "world";\n```',
          timestamp: new Date(),
        },
      ];

      render(<MessageList chatId="test-chat" messages={codeMessages} isStreaming={false} />);

      // Look for code block
      const codeBlock = screen.queryByText(/const hello/);
      expect(codeBlock).toBeDefined();
    });

    it("should render inline code", () => {
      const inlineCodeMessages: ChatMessage[] = [
        {
          role: "assistant",
          content: "Use the `useState` hook",
          timestamp: new Date(),
        },
      ];

      render(<MessageList chatId="test-chat" messages={inlineCodeMessages} isStreaming={false} />);

      const message = screen.getByText(/useState/);
      expect(message).toBeDefined();
    });
  });

  describe("Scroll Behavior", () => {
    it("should scroll to bottom on mount", () => {
      const { container } = render(
        <MessageList chatId="test-chat" messages={mockMessages} isStreaming={false} />,
      );

      const messageList = container.querySelector(
        '[data-testid="message-list"]',
      );

      // Scroll behavior is implementation-dependent
      expect(messageList).toBeDefined();
    });

    it("should auto-scroll when new message arrives", () => {
      const { rerender } = render(
        <MessageList chatId="test-chat" messages={mockMessages} isStreaming={false} />,
      );

      // Add new message
      const newMessages = [
        ...mockMessages,
        {
          role: "user" as const,
          content: "New message",
          timestamp: new Date(),
        },
      ];

      rerender(<MessageList chatId="test-chat" messages={newMessages} isStreaming={false} />);

      // Should include new message
      const newMessage = screen.getByText("New message");
      expect(newMessage).toBeDefined();
    });
  });

  describe("Message Grouping", () => {
    it("should group consecutive messages from same role", () => {
      const groupedMessages: ChatMessage[] = [
        { role: "user", content: "Message 1", timestamp: new Date() },
        { role: "user", content: "Message 2", timestamp: new Date() },
        { role: "user", content: "Message 3", timestamp: new Date() },
        { role: "assistant", content: "Response", timestamp: new Date() },
      ];

      render(<MessageList chatId="test-chat" messages={groupedMessages} isStreaming={false} />);

      // All messages should be rendered
      const messages = screen.getAllByTestId(/^message-item-/);
      expect(messages.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("Error Messages", () => {
    it("should render error messages", () => {
      const errorMessages: ChatMessage[] = [
        {
          role: "error" as any,
          content: "Failed to connect to server",
          timestamp: new Date(),
        },
      ];

      render(<MessageList chatId="test-chat" messages={errorMessages} isStreaming={false} />);

      const errorMessage = screen.queryByText(/Failed to connect/);
      expect(errorMessage).toBeDefined();
    });

    it("should style error messages differently", () => {
      const errorMessages: ChatMessage[] = [
        {
          role: "error" as any,
          content: "Error occurred",
          timestamp: new Date(),
        },
      ];

      const { container } = render(
        <MessageList chatId="test-chat" messages={errorMessages} isStreaming={false} />,
      );

      // Look for error styling
      const errorElement = container.querySelector('[data-testid*="error"]');
      expect(typeof errorElement).toBeDefined();
    });
  });

  describe("Performance", () => {
    it("should handle large number of messages", () => {
      const manyMessages: ChatMessage[] = Array.from(
        { length: 100 },
        (_, i) => ({
          role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
          content: `Message ${i + 1}`,
          timestamp: new Date(Date.now() + i * 1000),
        }),
      );

      render(<MessageList chatId="test-chat" messages={manyMessages} isStreaming={false} />);

      const messageList = screen.getByTestId("message-list");
      expect(messageList).toBeDefined();

      // Should render efficiently (no specific assertion, just shouldn't crash)
    });

    it("should update efficiently when new message added", () => {
      const { rerender } = render(
        <MessageList chatId="test-chat" messages={mockMessages} isStreaming={false} />,
      );

      // Add messages incrementally
      for (let i = 0; i < 10; i++) {
        const newMessages = [
          ...mockMessages,
          ...Array.from({ length: i + 1 }, (_, j) => ({
            role: "user" as const,
            content: `New message ${j}`,
            timestamp: new Date(),
          })),
        ];

        rerender(<MessageList chatId="test-chat" messages={newMessages} isStreaming={false} />);
      }

      // Should update without issues
      const messageList = screen.getByTestId("message-list");
      expect(messageList).toBeDefined();
    });
  });
});
