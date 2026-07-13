import { describe, expect, it } from "vitest";
import {
  computeHistoryTrimBounds,
  isInjectedContextUserMessage,
  MID_TURN_MAX_TOKENS,
  trimOldestHistoryTurns,
} from "../src/gateway/services/agent/midTurnContextTrim.js";

describe("midTurnContextTrim", () => {
  it("detects injected context user messages", () => {
    expect(
      isInjectedContextUserMessage(
        "[CONVERSATION CONTEXT - Earlier messages have been compressed]",
      ),
    ).toBe(true);
    expect(isInjectedContextUserMessage("What is the weather?")).toBe(false);
  });

  it("computes trim bounds at the current user turn", () => {
    const messages = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: "[CONVERSATION CONTEXT - Earlier messages]",
      },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current question" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1" }] },
      { role: "tool", content: [{ type: "tool-result", result: "ok" }] },
    ];

    const bounds = computeHistoryTrimBounds(messages);
    expect(bounds.historyStartIndex).toBe(1);
    expect(bounds.currentTurnStartIndex).toBe(4);
  });

  it("removes oldest history turns when over token cap", () => {
    const big = "x".repeat(400_000);
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "turn 1 question" },
      { role: "assistant", content: big },
      { role: "user", content: "turn 2 question" },
      { role: "assistant", content: big },
      { role: "user", content: "turn 3 question" },
      { role: "assistant", content: big },
      { role: "user", content: "turn 4 question" },
      { role: "assistant", content: big },
      { role: "user", content: "turn 5 question" },
      { role: "assistant", content: big },
      { role: "user", content: "current question" },
      { role: "assistant", content: "working" },
    ];

    const bounds = computeHistoryTrimBounds(messages);
    const stats = trimOldestHistoryTurns(messages, {
      ...bounds,
      maxTokens: MID_TURN_MAX_TOKENS,
      minPreservedTurns: 2,
    });

    expect(stats.removedTurns).toBeGreaterThan(0);
    expect(stats.tokensAfter).toBeLessThanOrEqual(MID_TURN_MAX_TOKENS);
    expect(messages.some((m) => m.content === "current question")).toBe(true);
    expect(messages.some((m) => m.content === "turn 1 question")).toBe(false);
  });

  it("does not trim the current in-progress turn", () => {
    const messages = [
      { role: "user", content: "old" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "current" },
      { role: "assistant", content: "step 1" },
      { role: "tool", content: [{ type: "tool-result", result: "data" }] },
    ];

    const bounds = computeHistoryTrimBounds(messages);
    trimOldestHistoryTurns(messages, {
      ...bounds,
      maxTokens: 1,
      minPreservedTurns: 0,
    });

    expect(messages.some((m) => m.content === "current")).toBe(true);
    expect(messages.some((m) => m.role === "tool")).toBe(true);
  });
});
