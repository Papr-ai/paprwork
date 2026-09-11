import { describe, expect, it } from "vitest";
import {
  createTurnMetrics,
  isRedundantRecovery,
  recordCompactionRun,
  recordCompactionSkipped,
  recordLoopSteps,
  recordRecoveryFetch,
  recordStep,
  setToolCallCount,
  summarizeTurnMetrics,
} from "../src/gateway/services/agent/turnMetrics.js";
import { ABSOLUTE_TOOL_RESULT_MAX_CHARS } from "../src/gateway/services/agent/toolResultTruncation.js";
import { compactStaleToolResults } from "../src/gateway/services/agent/compactToolResults.js";

describe("turn metrics — recording", () => {
  it("counts steps and keeps the largest context seen", () => {
    const m = createTurnMetrics();
    recordStep(m, { estimatedTokens: 40_000, historyTokenBudget: 200_000 });
    recordStep(m, { estimatedTokens: 120_000, historyTokenBudget: 200_000 });
    recordStep(m, { estimatedTokens: 90_000, historyTokenBudget: 200_000 });

    expect(m.steps).toBe(3);
    expect(m.peakContextTokens).toBe(120_000);
    expect(m.historyTokenBudget).toBe(200_000);
  });

  it("sets tool calls rather than accumulating them", () => {
    // Both routes produce a finished tool-call list, and the OAuth route also
    // reports its own running total. Adding would double it on that route.
    const m = createTurnMetrics();
    setToolCallCount(m, 12);
    setToolCallCount(m, 12);
    expect(m.toolCalls).toBe(12);
  });

  it("adds loop-reported steps to any already recorded", () => {
    const m = createTurnMetrics();
    recordStep(m, { estimatedTokens: 10_000 });
    recordLoopSteps(m, { steps: 4, estimatedTokens: 55_000 });
    expect(m.steps).toBe(5);
    expect(m.peakContextTokens).toBe(55_000);
  });

  it("separates compaction that ran from compaction that was gated off", () => {
    const m = createTurnMetrics();
    recordCompactionRun(m, {
      staleResultsTruncated: 2,
      staleResultsLeftInline: 5,
    });
    recordCompactionSkipped(m);
    recordCompactionSkipped(m);

    expect(m.compactionRuns).toBe(1);
    expect(m.compactionSkips).toBe(2);
    expect(m.staleResultsTruncated).toBe(2);
    expect(m.staleResultsLeftInline).toBe(5);
  });

  it("is a no-op without a collector, so jobs and sub-agents are unaffected", () => {
    expect(() => {
      recordStep(null, { estimatedTokens: 1 });
      recordLoopSteps(undefined, { steps: 3 });
      setToolCallCount(null, 4);
      recordCompactionRun(null, {});
      recordCompactionSkipped(undefined);
      recordRecoveryFetch(null, 900);
    }).not.toThrow();
  });
});

describe("turn metrics — redundant recovery", () => {
  it("classifies a result that would have fit the fresh ceiling as redundant", () => {
    expect(isRedundantRecovery(796)).toBe(true);
    expect(isRedundantRecovery(ABSOLUTE_TOOL_RESULT_MAX_CHARS)).toBe(true);
  });

  it("does not classify a genuinely oversized result as redundant", () => {
    // Above the fresh ceiling the fetch recovers something the turn really
    // would have lost, so it is not the loop this metric is looking for.
    expect(isRedundantRecovery(ABSOLUTE_TOOL_RESULT_MAX_CHARS + 1)).toBe(false);
    expect(isRedundantRecovery(5_600_000)).toBe(false);
  });

  it("ignores an empty recovery", () => {
    expect(isRedundantRecovery(0)).toBe(false);
  });

  it("counts every fetch but only the redundant ones as redundant", () => {
    const m = createTurnMetrics();
    recordRecoveryFetch(m, 796);
    recordRecoveryFetch(m, 1_041);
    recordRecoveryFetch(m, 500_000);

    expect(m.recoveryFetches).toBe(3);
    expect(m.redundantRecoveries).toBe(2);
    expect(m.recoveredChars).toBe(796 + 1_041 + 500_000);
  });
});

describe("turn metrics — summary", () => {
  it("derives the fill ratio and the recovery rate", () => {
    const m = createTurnMetrics();
    recordStep(m, { estimatedTokens: 150_000, historyTokenBudget: 200_000 });
    setToolCallCount(m, 8);
    recordRecoveryFetch(m, 900);
    recordRecoveryFetch(m, 900);

    const summary = summarizeTurnMetrics(m);
    expect(summary.contextFillRatio).toBe(0.75);
    expect(summary.redundantRecoveryRate).toBe(0.25);
  });

  it("reports null rather than zero when there is no denominator", () => {
    // Zero would read as "measured, and it was zero" — which is a different
    // claim from "no budget applied" or "no tool calls to divide by".
    const summary = summarizeTurnMetrics(createTurnMetrics());
    expect(summary.contextFillRatio).toBeNull();
    expect(summary.redundantRecoveryRate).toBeNull();
  });

  it("reports plan completion only when a plan actually ran", () => {
    const m = createTurnMetrics();

    expect(summarizeTurnMetrics(m).planCompleted).toBeNull();

    expect(
      summarizeTurnMetrics(m, {
        planCount: 1,
        totalSteps: 5,
        completedSteps: 5,
        pendingSteps: 0,
      }).planCompleted,
    ).toBe(true);

    expect(
      summarizeTurnMetrics(m, {
        planCount: 1,
        totalSteps: 5,
        completedSteps: 2,
        pendingSteps: 3,
      }).planCompleted,
    ).toBe(false);
  });

  it("carries only numbers, booleans and nulls", () => {
    // The privacy invariant: this shape is reported in aggregate, so a string
    // field here would be a channel for message content or a file path.
    const m = createTurnMetrics();
    recordStep(m, { estimatedTokens: 1_000, historyTokenBudget: 10_000 });
    setToolCallCount(m, 3);
    recordRecoveryFetch(m, 500);

    const summary = summarizeTurnMetrics(m, {
      planCount: 1,
      totalSteps: 2,
      completedSteps: 1,
      pendingSteps: 1,
    });

    for (const [key, value] of Object.entries(summary)) {
      expect(
        value === null ||
          typeof value === "number" ||
          typeof value === "boolean",
        `${key} must be numeric, boolean or null — got ${typeof value}`,
      ).toBe(true);
    }
  });
});

describe("compaction reports whether it ran", () => {
  function twoBatchConversation(resultChars: number): unknown[] {
    const result = "x".repeat(resultChars);
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
        content: [{ type: "text", text: result }],
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
        content: [{ type: "text", text: result }],
      },
    ];
  }

  it("marks a pressure-gated call as skipped, not as a run that cut nothing", () => {
    const stats = compactStaleToolResults(twoBatchConversation(50_000), {
      historyTokenBudget: 10_000_000,
    });
    expect(stats.skipped).toBe(true);
    expect(stats.staleResultsTruncated).toBe(0);
  });

  it("marks a call under pressure as a run", () => {
    const stats = compactStaleToolResults(twoBatchConversation(50_000), {
      historyTokenBudget: 1_000,
    });
    expect(stats.skipped).toBe(false);
  });
});
