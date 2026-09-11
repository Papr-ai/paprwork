import { describe, expect, test } from "vitest";
import {
  COMPACTION_PRESSURE_RATIO,
  MID_TURN_INLINE_FLOOR_CHARS,
  resolveStaleLengthAllowance,
  shouldCompactMidTurn,
} from "../src/gateway/services/agent/compactionPressure.js";
import { compactStaleToolResults } from "../src/gateway/services/agent/compactToolResults.js";

/**
 * Build a two-batch pi-ai conversation. The first result is stale (an assistant
 * message follows it), the second is fresh.
 */
function twoBatchConversation(staleResult: string, freshResult = "fresh") {
  return [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: staleResult }],
    },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_2", name: "bash", arguments: { command: "pwd" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "bash",
      content: [{ type: "text", text: freshResult }],
    },
  ];
}

function staleText(messages: ReturnType<typeof twoBatchConversation>): string {
  return (messages[2] as { content: Array<{ text: string }> }).content[0].text;
}

describe("shouldCompactMidTurn", () => {
  test("does not compact while the context fits comfortably in the budget", () => {
    expect(
      shouldCompactMidTurn({ estimatedTokens: 50_000, historyTokenBudget: 150_000 }),
    ).toBe(false);
  });

  test("compacts once the context reaches the pressure ratio", () => {
    const budget = 150_000;
    const atRatio = budget * COMPACTION_PRESSURE_RATIO;
    expect(shouldCompactMidTurn({ estimatedTokens: atRatio, historyTokenBudget: budget })).toBe(
      true,
    );
    expect(
      shouldCompactMidTurn({ estimatedTokens: atRatio - 1, historyTokenBudget: budget }),
    ).toBe(false);
  });

  test("compacts when the context is over budget", () => {
    expect(
      shouldCompactMidTurn({ estimatedTokens: 200_000, historyTokenBudget: 150_000 }),
    ).toBe(true);
  });

  /**
   * The memory-pressure path and any caller without model context supply no
   * budget. They must keep the original unconditional behaviour — a missing
   * budget is not evidence of headroom.
   */
  test("compacts when no budget is known", () => {
    expect(shouldCompactMidTurn({ estimatedTokens: 10 })).toBe(true);
    expect(shouldCompactMidTurn({ estimatedTokens: 10, historyTokenBudget: 0 })).toBe(true);
    expect(shouldCompactMidTurn({ estimatedTokens: 10, historyTokenBudget: -1 })).toBe(true);
    expect(shouldCompactMidTurn({ estimatedTokens: 10, historyTokenBudget: NaN })).toBe(true);
    expect(
      shouldCompactMidTurn({ estimatedTokens: 10, historyTokenBudget: Infinity }),
    ).toBe(true);
  });

  test("a tighter user cap starts compacting sooner", () => {
    // Same conversation, two different user caps. 120K of context is pressure
    // against a 200K-derived budget and comfortable against a 1M-derived one.
    expect(
      shouldCompactMidTurn({ estimatedTokens: 120_000, historyTokenBudget: 150_000 }),
    ).toBe(true);
    expect(
      shouldCompactMidTurn({ estimatedTokens: 120_000, historyTokenBudget: 800_000 }),
    ).toBe(false);
  });

  test("honours an explicit ratio", () => {
    expect(
      shouldCompactMidTurn({
        estimatedTokens: 90_000,
        historyTokenBudget: 100_000,
        pressureRatio: 0.95,
      }),
    ).toBe(false);
  });
});

describe("resolveStaleLengthAllowance", () => {
  test("leaves a short result inline rather than cutting it to a pointer", () => {
    // The measured pathology: 796 chars cut to 400 saves 396 and provokes a
    // recovery fetch that returns 1,041 chars plus a whole extra step.
    expect(resolveStaleLengthAllowance(796, 400)).toBe(796);
  });

  test("still cuts a large payload all the way to its category limit", () => {
    // The floor must not blunt the cuts that pay for themselves. A 500KB bash
    // result collapses to 400 chars exactly as before.
    expect(resolveStaleLengthAllowance(500_000, 400)).toBe(400);
  });

  test("is binary at the floor, not graded up to it", () => {
    expect(resolveStaleLengthAllowance(MID_TURN_INLINE_FLOOR_CHARS, 400)).toBe(
      MID_TURN_INLINE_FLOOR_CHARS,
    );
    // One character over and the full saving applies — not a cut to the floor.
    expect(resolveStaleLengthAllowance(MID_TURN_INLINE_FLOOR_CHARS + 1, 400)).toBe(400);
  });

  test("is a no-op when the result already fits the category limit", () => {
    expect(resolveStaleLengthAllowance(100, 400)).toBe(400);
    expect(resolveStaleLengthAllowance(40_000, 40_000)).toBe(40_000);
  });

  test("a zero floor restores unconditional cutting for the memory-pressure path", () => {
    expect(resolveStaleLengthAllowance(796, 400, 0)).toBe(400);
    expect(resolveStaleLengthAllowance(1, 400, 0)).toBe(400);
  });
});

describe("compactStaleToolResults with a budget", () => {
  test("leaves stale results untouched while there is headroom", () => {
    const big = "x".repeat(200_000);
    const messages = twoBatchConversation(big);

    compactStaleToolResults(messages, { historyTokenBudget: 5_000_000 });

    expect(staleText(messages)).toBe(big);
  });

  test("cuts a large stale result once under pressure", () => {
    const big = "x".repeat(200_000);
    const messages = twoBatchConversation(big);

    compactStaleToolResults(messages, { historyTokenBudget: 1_000 });

    expect(staleText(messages).length).toBeLessThan(big.length);
  });

  test("never cuts a short stale result, even under pressure", () => {
    const short = "y".repeat(796);
    const messages = twoBatchConversation(short, "z".repeat(200_000));

    compactStaleToolResults(messages, { historyTokenBudget: 1_000 });

    expect(staleText(messages)).toBe(short);
  });

  test("omitting the budget compacts unconditionally, as before", () => {
    const big = "x".repeat(200_000);
    const messages = twoBatchConversation(big);

    compactStaleToolResults(messages);

    expect(staleText(messages).length).toBeLessThan(big.length);
  });
});
