import { describe, expect, it } from "vitest";
import {
  computeChatTurnFootprint,
  HISTORY_TOOL_RESULT_MAX_CHARS,
} from "../src/gateway/services/storage/contextFootprint.js";

describe("computeChatTurnFootprint", () => {
  it("compares full stored chat vs truncated agent context without summary", () => {
    const bigResult = "x".repeat(2000);
    const messages = [
      {
        role: "user",
        content: "hello",
        thinking: null,
        tool_calls: null,
      },
      {
        role: "assistant",
        content: "done",
        thinking: null,
        tool_calls: JSON.stringify([{ name: "bash", result: bigResult }]),
      },
    ];

    const footprint = computeChatTurnFootprint(
      {
        id: "chat-1",
        message_count: 2,
        title: "Test",
        summary_short: null,
        summary_medium: null,
        summary_long: null,
        summary_topics: null,
        summary_enhanced: null,
        summary_last_updated: null,
      },
      messages,
    );

    expect(footprint.fullChatTokens).toBeGreaterThan(
      footprint.agentContextTokens,
    );
    expect(footprint.truncationTokensSaved).toBeGreaterThan(0);
    expect(footprint.summaryTokensSaved).toBe(0);
    expect(footprint.tokensSavedPerTurn).toBe(
      footprint.truncationTokensSaved + footprint.summaryTokensSaved,
    );
    expect(footprint.agentContextTokens).toBeLessThan(
      Math.ceil((2000 + "done".length + "hello".length) / 4),
    );
    expect(HISTORY_TOOL_RESULT_MAX_CHARS).toBe(400);
  });

  it("replaces archived messages with summary text", () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: "a".repeat(1000),
      thinking: null,
      tool_calls: null,
    }));

    const footprint = computeChatTurnFootprint(
      {
        id: "chat-2",
        message_count: 8,
        title: "Summarized",
        summary_short: "short",
        summary_medium: "medium",
        summary_long: "long summary",
        summary_topics: JSON.stringify(["topic"]),
        summary_enhanced: null,
        summary_last_updated: "2026-01-01",
      },
      messages,
    );

    expect(footprint.hasSummary).toBe(true);
    expect(footprint.summaryTokensSaved).toBeGreaterThan(0);
    expect(footprint.fullChatTokens).toBeGreaterThan(
      footprint.agentContextTokens,
    );
  });
});
