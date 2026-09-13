import { describe, expect, it } from "vitest";
import {
  computeHistoryTokenBudget,
  resolveOutputReserve,
} from "../src/gateway/services/agent/contextBudget.js";
import {
  computeHistoryTrimBounds,
  HARD_MIN_PRESERVED_HISTORY_TURNS,
  MIN_PRESERVED_HISTORY_TURNS,
  trimOldestHistoryTurns,
} from "../src/gateway/services/agent/midTurnContextTrim.js";

/**
 * A user cap of 200K was exceeded on every turn of a real chat — 357,975 /
 * 369,620 / 370,892 / 383,058 / 458,356 billed input tokens, up to 2.3x the
 * cap — while a 400K cap in a sibling chat was respected. Two independent
 * defects compounded:
 *
 *  1. The output reserve was the model's advertised maximum output (128K),
 *     subtracted in full, so `200,000 * 0.85 - 87,363 - 128,000` went negative
 *     and clamped to the 8K minimum.
 *  2. `MIN_PRESERVED_HISTORY_TURNS` stopped the trimmer unconditionally at four
 *     turns, and those four carried ~1MB, so the cap was never reachable.
 *
 * Measured from the turn that produced these numbers: 150 tools at ~87,363
 * tokens of schema, `maxTokens` 128,000 on claude-opus-5.
 */
const MEASURED_TOOL_TOKENS = 87_363;
const MEASURED_MAX_OUTPUT = 128_000;

function budgetAtCap(cap: number | undefined): number {
  return computeHistoryTokenBudget({
    provider: "anthropic",
    modelId: "claude-opus-5",
    toolTokenEstimate: MEASURED_TOOL_TOKENS,
    maxOutputTokens: MEASURED_MAX_OUTPUT,
    contextLimit: cap,
  });
}

describe("output reserve cannot crowd out the history it is subtracted from", () => {
  it("stops a 200K cap collapsing to the 8K floor", () => {
    // Before the fix this was exactly 8_000: the raw budget computed to -45,363.
    // After: reserve is min(128_000, 200_000/3) = 66_666, so the budget is
    // 170_000 - 87_363 - 66_666.
    expect(budgetAtCap(200_000)).toBe(15_971);
  });

  it("leaves 400K and 1M budgets byte-identical", () => {
    // 128K is already under a third of 400K, so the cap cannot bind at or above
    // 400K. These are the values a live turn recorded in chats.db
    // (turn_context_budget_tokens = 124637 on a 400K chat).
    expect(budgetAtCap(400_000)).toBe(124_637);
    expect(budgetAtCap(1_000_000)).toBe(634_637);
  });

  it("leaves an uncapped chat on the model window alone", () => {
    expect(budgetAtCap(undefined)).toBe(budgetAtCap(1_000_000));
  });

  it("passes a modest reserve through untouched", () => {
    // The no-maxTokens default (16K) is far below a third of any large window.
    expect(resolveOutputReserve(400_000, 16_000)).toBe(16_000);
    expect(resolveOutputReserve(1_000_000, undefined)).toBe(16_000);
  });

  it("caps the reserve at a third of the window when the model asks for more", () => {
    expect(resolveOutputReserve(200_000, 128_000)).toBe(66_666);
    // A small local-model window: reserving 16K of 32,768 left nothing.
    expect(resolveOutputReserve(32_768, 16_000)).toBe(10_922);
  });

  it("still cannot rescue a window smaller than the tool schemas", () => {
    // ~87K of schemas against a 128K window is not an arithmetic problem, and
    // the floor is the honest answer rather than a negative budget.
    expect(budgetAtCap(128_000)).toBe(8_000);
  });
});

/** Six history turns of roughly equal weight, plus an in-progress turn. */
function buildHistory(turnChars: number, turnCount: number) {
  const body = "x".repeat(turnChars);
  const messages: Array<{ role: string; content: unknown }> = [
    { role: "system", content: "sys" },
  ];
  for (let i = 1; i <= turnCount; i += 1) {
    messages.push({ role: "user", content: `turn ${i} question` });
    messages.push({ role: "assistant", content: body });
  }
  messages.push({ role: "user", content: "current question" });
  messages.push({ role: "assistant", content: "working" });
  return messages;
}

describe("the preserved-turn floor is a preference, not a veto on the cap", () => {
  it("descends below the soft floor when the preserved turns exceed the budget", () => {
    // Four turns at ~10K tokens each is 40K — over the cap — so the old
    // unconditional stop at four left the prompt over budget indefinitely.
    const messages = buildHistory(40_000, 6);
    const bounds = computeHistoryTrimBounds(messages);

    const stats = trimOldestHistoryTurns(messages, {
      ...bounds,
      maxTokens: 25_000,
    });

    expect(stats.removedBelowSoftFloor).toBeGreaterThan(0);
    expect(stats.budgetMet).toBe(true);
    expect(stats.tokensAfter).toBeLessThanOrEqual(25_000);
    expect(messages.some((m) => m.content === "current question")).toBe(true);
  });

  it("does not touch the soft floor when the budget is already met", () => {
    // Trimming to four turns is enough here, so the descent must not engage —
    // otherwise the fix would quietly shrink history on healthy turns.
    const messages = buildHistory(40_000, 6);
    const bounds = computeHistoryTrimBounds(messages);

    const stats = trimOldestHistoryTurns(messages, {
      ...bounds,
      maxTokens: 45_000,
    });

    expect(stats.removedTurns).toBeGreaterThan(0);
    expect(stats.removedBelowSoftFloor).toBe(0);
    expect(stats.budgetMet).toBe(true);
  });

  it("keeps the in-progress turn even when descending to the hard floor", () => {
    const messages = buildHistory(400_000, 3);
    const bounds = computeHistoryTrimBounds(messages);

    trimOldestHistoryTurns(messages, { ...bounds, maxTokens: 1_000 });

    expect(messages.some((m) => m.content === "current question")).toBe(true);
    expect(messages.some((m) => m.content === "working")).toBe(true);
  });

  it("reports budgetMet false when one turn alone exceeds the cap", () => {
    // Trimming cannot fix this, and saying so is more useful than reporting a
    // successful trim that still ships an over-cap prompt.
    const messages = buildHistory(400_000, 2);
    const bounds = computeHistoryTrimBounds(messages);

    const stats = trimOldestHistoryTurns(messages, {
      ...bounds,
      maxTokens: 1_000,
    });

    expect(stats.budgetMet).toBe(false);
    expect(stats.tokensAfter).toBeGreaterThan(1_000);
  });

  it("never raises a caller's floor", () => {
    // The hard floor exists to lower the stop, so a caller asking for zero
    // preserved turns must keep getting zero.
    const messages = buildHistory(400_000, 4);
    const bounds = computeHistoryTrimBounds(messages);

    const stats = trimOldestHistoryTurns(messages, {
      ...bounds,
      maxTokens: 1_000,
      minPreservedTurns: 0,
    });

    expect(stats.removedTurns).toBe(4);
    expect(messages.some((m) => m.content === "current question")).toBe(true);
  });

  it("leaves an under-budget prompt completely alone", () => {
    const messages = buildHistory(100, 6);
    const bounds = computeHistoryTrimBounds(messages);
    const before = messages.length;

    const stats = trimOldestHistoryTurns(messages, {
      ...bounds,
      maxTokens: 1_000_000,
    });

    expect(stats.trimmed).toBe(false);
    expect(stats.removedBelowSoftFloor).toBe(0);
    expect(stats.budgetMet).toBe(true);
    expect(messages.length).toBe(before);
  });

  it("keeps the hard floor below the soft floor", () => {
    expect(HARD_MIN_PRESERVED_HISTORY_TURNS).toBeLessThan(
      MIN_PRESERVED_HISTORY_TURNS,
    );
  });
});
