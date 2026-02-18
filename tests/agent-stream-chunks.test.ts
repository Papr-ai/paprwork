import { describe, expect, test } from "vitest";
import {
  createChatStreamChunk,
  parseToolCallChunk,
  parseToolResultChunk,
  parseToolErrorChunk,
  truncateStringsInUnknown,
} from "../src/gateway/services/agent/streamChunks.js";
import { truncateResult } from "../src/core/tools/index.js";

describe("agent stream chunk helpers", () => {
  test("creates timestamped chat stream chunks", () => {
    const chunk = createChatStreamChunk(
      "text-delta",
      { text: "hello" },
      "chat-1",
    );

    expect(chunk.type).toBe("text-delta");
    expect(chunk.payload).toEqual({ text: "hello" });
    expect(chunk.chatId).toBe("chat-1");
    expect(typeof chunk.timestamp).toBe("string");
  });

  test("parses tool call chunk with input payload", () => {
    const parsed = parseToolCallChunk({
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "ls" },
    });

    expect(parsed).toEqual({
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });
  });

  test("parses tool result chunk with output and fallback result", () => {
    const parsedOutput = parseToolResultChunk({
      toolCallId: "call-1",
      toolName: "bash",
      output: "ok",
    });
    const parsedResult = parseToolResultChunk({
      toolCallId: "call-2",
      toolName: "bash",
      result: "fallback",
    });

    expect(parsedOutput?.result).toBe("ok");
    expect(parsedResult?.result).toBe("fallback");
  });

  test("parses tool-error chunk", () => {
    const parsed = parseToolErrorChunk({
      toolCallId: "call-1",
      toolName: "read_file",
      error: "permission denied",
    });

    expect(parsed).toEqual({
      toolCallId: "call-1",
      toolName: "read_file",
      error: "permission denied",
    });
  });

  test("truncates nested strings without altering structure", () => {
    const nested = {
      text: "a".repeat(60000),
      details: [
        { output: "b".repeat(70000) },
        "c".repeat(80000),
      ],
    };

    const truncated = truncateStringsInUnknown(nested) as {
      text: string;
      details: Array<{ output: string } | string>;
    };

    expect(truncated.text).toBe(truncateResult("a".repeat(60000)));
    expect(typeof truncated.details[0]).toBe("object");
    if (typeof truncated.details[0] === "object") {
      expect(truncated.details[0].output).toBe(truncateResult("b".repeat(70000)));
    }
    if (typeof truncated.details[1] === "string") {
      expect(truncated.details[1]).toBe(truncateResult("c".repeat(80000)));
    }
  });
});
