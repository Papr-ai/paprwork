import { describe, expect, test } from "vitest";
import {
  createAssistantStoredMessage,
  createErrorStoredMessage,
  formatToolResultForStorage,
} from "../src/gateway/services/agent/messagePersistence.js";

describe("agent message persistence", () => {
  test("formats tool results for storage safely", () => {
    expect(formatToolResultForStorage(undefined)).toBeUndefined();
    expect(formatToolResultForStorage(null)).toBeUndefined();
    expect(formatToolResultForStorage("plain")).toBe("plain");
    expect(formatToolResultForStorage({ ok: true })).toBe('{"ok":true}');

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(formatToolResultForStorage(circular)).toBe("[object Object]");
  });

  test("builds assistant message payload with mapped tool results", () => {
    const message = createAssistantStoredMessage({
      chatId: "chat-1",
      model: "gpt-5",
      assistantText: "Hello",
      thinkingText: "Thinking...",
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "read_file",
          args: { path: "/tmp/file.txt" },
        },
        {
          toolCallId: "call-2",
          toolName: "bash",
          args: { command: "pwd" },
        },
      ],
      toolResults: [
        {
          toolCallId: "call-1",
          toolName: "read_file",
          result: { data: "ok" },
        },
      ],
    });

    expect(message.id).toMatch(/^msg-/);
    expect(message.chat_id).toBe("chat-1");
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("Hello");
    expect(message.thinking).toBe("Thinking...");
    expect(message.model).toBe("gpt-5");
    expect(message.sync_status).toBe("local");
    expect(typeof message.timestamp).toBe("string");
    expect(message.toolCalls).toEqual([
      {
        id: "call-1",
        name: "read_file",
        args: { path: "/tmp/file.txt" },
        result: '{"data":"ok"}',
        status: "success",
      },
      {
        id: "call-2",
        name: "bash",
        args: { command: "pwd" },
        result: undefined,
        status: "success",
      },
    ]);
  });

  test("builds error message payload using assistant text when present", () => {
    const message = createErrorStoredMessage({
      chatId: "chat-2",
      model: "claude-sonnet",
      assistantText: "Partial output",
      thinkingText: "",
      toolCalls: [],
      toolResults: [],
      errorMessage: "stream disconnected",
    });

    expect(message.content).toBe(
      "Partial output\n\n---\n❌ **Error**: stream disconnected",
    );
    expect(message.error).toBe("stream disconnected");
    expect(message.incomplete).toBe(true);
    expect(message.toolCalls).toBeUndefined();
  });

  test("builds error message payload with tool fallback content", () => {
    const message = createErrorStoredMessage({
      chatId: "chat-3",
      model: "gpt-4.1",
      assistantText: "",
      thinkingText: "step",
      toolCalls: [
        {
          toolCallId: "call-3",
          toolName: "bash",
          args: { command: "echo hi" },
        },
      ],
      toolResults: [
        {
          toolCallId: "call-3",
          toolName: "bash",
          result: "hi",
        },
      ],
      errorMessage: "timeout",
    });

    expect(message.content).toBe(
      "⚠️ Response interrupted after 1 tool call(s)\n\n---\n❌ **Error**: timeout",
    );
    expect(message.toolCalls).toEqual([
      {
        id: "call-3",
        name: "bash",
        args: { command: "echo hi" },
        result: "hi",
        status: "error",
      },
    ]);
  });

  test("builds error message payload with generic fallback content", () => {
    const message = createErrorStoredMessage({
      chatId: "chat-4",
      model: "gpt-4.1",
      assistantText: "",
      thinkingText: "",
      toolCalls: [],
      toolResults: [],
      errorMessage: "unknown failure",
    });

    expect(message.content).toBe(
      "❌ An error occurred while generating the response\n\n---\n❌ **Error**: unknown failure",
    );
  });
});
