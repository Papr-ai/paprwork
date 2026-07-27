import { describe, expect, test } from "vitest";
import { compactStaleAssistantReasoning } from "../src/gateway/services/agent/compactToolResults.js";

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
