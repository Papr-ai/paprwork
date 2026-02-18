import { describe, expect, test } from "vitest";
import {
  buildModelMessages,
  formatHistoryMessagesForModel,
  formatMessageContentForModel,
} from "../src/gateway/services/agent/historyFormatter.js";

describe("agent history formatter", () => {
  test("formats mixed history shapes into model messages", () => {
    const history: unknown[] = [
      { role: "user", content: "hello" },
      { message_role: "assistant", message: "hi there" },
      { role: "assistant", content: { text: "object text" } },
      { role: "invalid", content: "ignored" },
      { role: "user", content: 123 },
    ];

    const messages = formatHistoryMessagesForModel(history);

    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "assistant", content: "object text" },
    ]);
  });

  test("buildModelMessages adds system and current user message", () => {
    const history: unknown[] = [{ role: "assistant", content: "prior response" }];
    const messages = buildModelMessages(
      history,
      "new prompt",
      "system instructions",
    );

    expect(messages[0]).toEqual({
      role: "system",
      content: "system instructions",
    });
    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content: "new prompt",
    });
  });

  test("does not duplicate system message when history already has one", () => {
    const history: unknown[] = [
      { role: "system", content: "already present" },
      { role: "user", content: "question" },
    ];
    const messages = buildModelMessages(history, "new question", "new system");
    const systemCount = messages.filter((message) => message.role === "system").length;

    expect(systemCount).toBe(1);
    expect(messages[0].content).toBe("already present");
  });

  test("produces structured AI SDK messages for tool calls", () => {
    const history: unknown[] = [
      {
        role: "assistant",
        content: "I checked the repo",
        toolCalls: [
          {
            id: "call-1",
            name: "bash",
            args: { command: "npm test" },
            result: "ok",
            status: "success",
          },
        ],
      },
    ];

    const messages = formatHistoryMessagesForModel(history);

    // Should produce 2 messages: assistant with tool-call, then tool with tool-result
    expect(messages).toHaveLength(2);

    // First message: assistant with structured content
    expect(messages[0].role).toBe("assistant");
    expect(Array.isArray(messages[0].content)).toBe(true);

    const assistantContent = messages[0].content as Array<{
      type: string;
      text?: string;
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
    }>;

    // Should have text part and tool-call part
    expect(assistantContent).toHaveLength(2);
    expect(assistantContent[0]).toEqual({
      type: "text",
      text: "I checked the repo",
    });
    expect(assistantContent[1]).toEqual({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "npm test" },
    });

    // Second message: tool results
    expect(messages[1].role).toBe("tool");
    const toolContent = messages[1].content as Array<{
      type: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
    }>;
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0]).toEqual({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "bash",
      result: "ok",
    });
  });

  test("does NOT include [tool_activity] text in formatted messages", () => {
    const history: unknown[] = [
      {
        role: "assistant",
        content: "I ran the command",
        tool_calls: [
          {
            id: "call-2",
            name: "bash",
            args: { command: "ls" },
            result: "file1.ts\nfile2.ts",
            status: "success",
          },
        ],
      },
    ];

    const messages = formatHistoryMessagesForModel(history);

    // Verify no [tool_activity] text exists anywhere
    const allContent = JSON.stringify(messages);
    expect(allContent).not.toContain("[tool_activity]");
  });

  test("handles assistant messages without tool calls as plain text", () => {
    const history: unknown[] = [
      { role: "assistant", content: "Just a normal response" },
    ];

    const messages = formatHistoryMessagesForModel(history);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: "assistant",
      content: "Just a normal response",
    });
  });

  test("handles multiple tool calls in one message", () => {
    const history: unknown[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-a",
            name: "read_file",
            args: { path: "package.json" },
            result: '{"name": "test"}',
            status: "success",
          },
          {
            id: "call-b",
            name: "bash",
            args: { command: "npm test" },
            result: "All tests passed",
            status: "success",
          },
        ],
      },
    ];

    const messages = formatHistoryMessagesForModel(history);

    expect(messages).toHaveLength(2);

    // Assistant message should have 2 tool calls (empty text is omitted)
    const assistantContent = messages[0].content as Array<{ type: string }>;
    expect(assistantContent).toHaveLength(2); // 2 tool-calls (no text since content was empty)

    // Tool results message should have 2 results
    const toolContent = messages[1].content as Array<{ type: string }>;
    expect(toolContent).toHaveLength(2);
  });

  test("formatMessageContentForModel returns brief tool summary (not [tool_activity])", () => {
    const message = {
      role: "assistant",
      content: "I checked the repo",
      toolCalls: [
        { id: "call-1", name: "bash", args: {}, result: "ok", status: "success" },
        { id: "call-2", name: "read_file", args: {}, result: "content", status: "success" },
      ],
    };

    const content = formatMessageContentForModel(message);

    expect(content).not.toContain("[tool_activity]");
    expect(content).toContain("Used tools: bash, read_file");
    expect(content).toContain("I checked the repo");
  });

  test("full conversation flow with user -> assistant(tool) -> user produces valid structure", () => {
    const history: unknown[] = [
      { role: "user", content: "Read my package.json" },
      {
        role: "assistant",
        content: "Here's what I found",
        toolCalls: [
          {
            id: "tc-1",
            name: "read_file",
            args: { path: "package.json" },
            result: '{"name": "myapp"}',
            status: "success",
          },
        ],
      },
      { role: "user", content: "Now update the version" },
    ];

    const messages = buildModelMessages(history, "thanks", "You are an assistant");

    // Expected: system, user, assistant(tool-call), tool(result), user, user(new)
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[2].role).toBe("assistant");
    expect(messages[3].role).toBe("tool");
    expect(messages[4].role).toBe("user");
    expect(messages[5].role).toBe("user"); // new message

    // Verify no [tool_activity] anywhere
    expect(JSON.stringify(messages)).not.toContain("[tool_activity]");
  });
});
