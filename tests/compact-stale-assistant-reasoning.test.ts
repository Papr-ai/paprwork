import { describe, expect, test } from "vitest";
import {
  compactStaleAssistantReasoning,
  compactMidTurnContextForMemoryPressure,
  stripAllAssistantReasoning,
} from "../src/gateway/services/agent/compactToolResults.js";

describe("compactStaleAssistantReasoning", () => {
  test("strips thinking from stale assistant turns but keeps the latest batch", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning block" },
          { type: "text", text: "First answer" },
          {
            type: "toolCall",
            id: "call_1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "fresh reasoning block" },
          { type: "text", text: "Second answer" },
          {
            type: "toolCall",
            id: "call_2",
            name: "read_file",
            arguments: { path: "/tmp/x" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "read_file",
        content: [{ type: "text", text: "file body" }],
      },
    ];

    const stats = compactStaleAssistantReasoning(messages);

    expect(stats.strippedMessages).toBe(1);
    expect(stats.removedParts).toBeGreaterThan(0);

    const staleAssistant = messages[0] as {
      content: Array<{ type: string; thinking?: string }>;
    };
    expect(
      staleAssistant.content.some((part) => part.type === "thinking"),
    ).toBe(false);

    const freshAssistant = messages[2] as {
      content: Array<{ type: string; thinking?: string }>;
    };
    expect(
      freshAssistant.content.some(
        (part) => part.type === "thinking" && part.thinking === "fresh reasoning block",
      ),
    ).toBe(true);
  });
});

describe("stripAllAssistantReasoning", () => {
  test("strips thinking from every assistant message including the latest", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning" },
          { type: "text", text: "First" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest reasoning" },
          { type: "text", text: "Second" },
        ],
      },
    ];

    const stats = stripAllAssistantReasoning(messages);

    expect(stats.strippedMessages).toBe(2);
    for (const msg of messages) {
      const assistant = msg as { content: Array<{ type: string }> };
      expect(
        assistant.content.some((part) => part.type === "thinking"),
      ).toBe(false);
    }
  });
});

describe("compactMidTurnContextForMemoryPressure", () => {
  test("truncates stale file reads to aggressive limit", () => {
    const fileContent = "line\n".repeat(800);
    const messages = [
      { role: "user", content: "read" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "read-1", toolName: "read_file", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            toolName: "read_file",
            output: { type: "text", value: fileContent },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "bash-1", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "bash-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ];

    compactMidTurnContextForMemoryPressure(messages);

    const readPart = (messages[2] as { content: Array<{ output?: { value: string } }> })
      .content[0]!;
    const readResult = readPart.output?.value ?? "";

    expect(readResult.length).toBeLessThan(fileContent.length);
    expect(readResult.length).toBeLessThanOrEqual(500);
  });
});
