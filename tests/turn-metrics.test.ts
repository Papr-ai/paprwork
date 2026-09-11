import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  migrateTurnMetricsColumns,
  readChatUsageTotals,
  readLastTurnUsage,
  storeTurnMetrics,
} from "../src/gateway/services/storage/turnMetricsStore.js";
import {
  createTurnMetrics,
  isRedundantRecovery,
  recordCompactionRun,
  recordCompactionSkipped,
  recordLoopSteps,
  recordObservedContext,
  recordRecoveryFetch,
  recordStep,
  setToolCallCount,
  summarizeTurnMetrics,
} from "../src/gateway/services/agent/turnMetrics.js";
import { ABSOLUTE_TOOL_RESULT_MAX_CHARS } from "../src/gateway/services/agent/toolResultTruncation.js";
import {
  compactStaleToolResults,
  estimateMessagesTokens,
} from "../src/gateway/services/agent/compactToolResults.js";

describe("turn metrics — recording", () => {
  it("counts steps and keeps the largest context seen", () => {
    const m = createTurnMetrics();
    recordStep(m, { estimatedTokens: 40_000, historyTokenBudget: 200_000 });
    recordStep(m, { estimatedTokens: 120_000, historyTokenBudget: 200_000 });
    recordStep(m, { estimatedTokens: 90_000, historyTokenBudget: 200_000 });

    expect(m.steps).toBe(3);
    expect(m.estimatedPeakContextTokens).toBe(120_000);
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
    expect(m.estimatedPeakContextTokens).toBe(55_000);
  });

  it("keeps the provider's figure apart from the estimate", () => {
    // These disagreed by ~1.9x on real turns, and only the estimate was ever
    // persisted. Both are the real 2026-09 figures from chat 01eed089.
    const m = createTurnMetrics();
    recordStep(m, { estimatedTokens: 204_052, historyTokenBudget: 124_637 });
    recordObservedContext(m, 388_080);

    expect(m.estimatedPeakContextTokens).toBe(204_052);
    expect(m.observedPeakContextTokens).toBe(388_080);
  });

  it("ignores a missing or zero observation rather than lowering the peak", () => {
    // A step that reports no usage must not be read as "the context was zero".
    const m = createTurnMetrics();
    recordObservedContext(m, 388_080);
    recordObservedContext(m, 0);
    recordObservedContext(m, Number.NaN);
    recordObservedContext(m, 12_000);

    expect(m.observedPeakContextTokens).toBe(388_080);
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

  it("persists the billed prompt as the peak, and the estimate beside it", () => {
    const m = createTurnMetrics();
    recordStep(m, { estimatedTokens: 204_052, historyTokenBudget: 124_637 });
    recordObservedContext(m, 388_080);

    const summary = summarizeTurnMetrics(m);
    expect(summary.peakContextTokens).toBe(388_080);
    expect(summary.estimatedContextTokens).toBe(204_052);
    expect(summary.estimatorErrorRatio).toBe(1.902);
  });

  it("keeps the fill ratio on the estimate, because that is what the gate compares", () => {
    // Substituting the provider's figure here would break the one thing this
    // ratio reports faithfully: how full the truncation ladder believed it was.
    const m = createTurnMetrics();
    recordStep(m, { estimatedTokens: 100_000, historyTokenBudget: 200_000 });
    recordObservedContext(m, 380_000);

    expect(summarizeTurnMetrics(m).contextFillRatio).toBe(0.5);
  });

  it("falls back to the estimate when no step reported usage", () => {
    const m = createTurnMetrics();
    recordStep(m, { estimatedTokens: 181_281, historyTokenBudget: 124_637 });

    const summary = summarizeTurnMetrics(m);
    expect(summary.peakContextTokens).toBe(181_281);
    expect(summary.estimatorErrorRatio).toBeNull();
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

describe("context estimator — what it can see", () => {
  it("counts tool-call arguments, not only tool results", () => {
    // A write_file call carries the whole file body in its arguments. Counting
    // only what came back made everything the agent sent free, which was a
    // standing ~1.25x underestimate on real chat data.
    const body = "X".repeat(40_000);
    const withCall = estimateMessagesTokens([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_01",
            toolName: "write_file",
            input: { path: "/a/b.ts", content: body },
          },
        ],
      },
    ]);

    expect(withCall).toBeGreaterThan(body.length / 4);
  });

  it("reads pi-ai's argument field as well as the AI SDK's", () => {
    const args = { command: "Y".repeat(8_000) };
    const aiSdk = estimateMessagesTokens([
      { role: "assistant", content: [{ type: "tool-call", input: args }] },
    ]);
    const piAi = estimateMessagesTokens([
      { role: "assistant", content: [{ type: "tool_use", arguments: args }] },
    ]);

    expect(aiSdk).toBe(piAi);
    expect(aiSdk).toBeGreaterThan(1_000);
  });

  it("measures a string argument as-is rather than re-serialising it", () => {
    // Already the wire form; JSON.stringify would add escaping the provider
    // does not bill for.
    const raw = '{"query":"' + "Z".repeat(4_000) + '"}';
    const tokens = estimateMessagesTokens([
      { role: "assistant", content: [{ type: "tool-call", args: raw }] },
    ]);

    expect(tokens).toBe(Math.ceil(raw.length / 4));
  });

  it("counts nothing for a tool call with no arguments", () => {
    expect(
      estimateMessagesTokens([
        { role: "assistant", content: [{ type: "tool-call", input: null }] },
      ]),
    ).toBe(0);
  });

  it("still counts tool results, and does not double-count them as arguments", () => {
    const result = "R".repeat(12_000);
    const tokens = estimateMessagesTokens([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_01",
            output: { type: "text", value: result },
          },
        ],
      },
    ]);

    expect(tokens).toBe(Math.ceil(result.length / 4));
  });
});

describe("context meter — reading measured usage", () => {
  const openDb = () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT,
        role TEXT,
        timestamp TEXT,
        sequence INTEGER,
        model TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        cost REAL
      )`);
    migrateTurnMetricsColumns(db);
    return db;
  };

  const insert = (
    db: Database.Database,
    row: Record<string, string | number | null>,
  ) => {
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO messages (${keys.join(", ")}) VALUES (${keys
        .map(() => "?")
        .join(", ")})`,
    ).run(...keys.map((key) => row[key]));
  };

  it("returns the newest billed assistant turn, with its metrics", () => {
    const db = openDb();
    insert(db, {
      id: "a",
      chat_id: "c1",
      role: "assistant",
      sequence: 1,
      model: "claude-sonnet-5",
      prompt_tokens: 100_000,
      completion_tokens: 900,
      cache_read_tokens: 80_000,
      cache_write_tokens: 1_000,
      cost: 0.1,
    });
    insert(db, {
      id: "b",
      chat_id: "c1",
      role: "assistant",
      sequence: 2,
      model: "claude-sonnet-5",
      prompt_tokens: 369_600,
      completion_tokens: 2_400,
      cache_read_tokens: 300_000,
      cache_write_tokens: 4_000,
      cost: 0.238,
    });
    storeTurnMetrics(
      db,
      "b",
      summarizeTurnMetrics(
        (() => {
          const m = createTurnMetrics();
          recordStep(m, { estimatedTokens: 180_000, historyTokenBudget: 200_000 });
          setToolCallCount(m, 12);
          return m;
        })(),
      ),
      48_200,
    );

    const turn = readLastTurnUsage(db, "c1");
    expect(turn?.messageId).toBe("b");
    expect(turn?.promptTokens).toBe(369_600);
    expect(turn?.toolCalls).toBe(12);
    expect(turn?.durationMs).toBe(48_200);
    expect(turn?.peakContextTokens).toBe(180_000);
  });

  it("ignores user rows and unbilled assistant rows", () => {
    const db = openDb();
    insert(db, {
      id: "u",
      chat_id: "c1",
      role: "user",
      sequence: 1,
      prompt_tokens: 0,
    });
    // An interrupted turn persists with no usage; the meter must not read it
    // as the current context size and paint the ring empty.
    insert(db, {
      id: "empty",
      chat_id: "c1",
      role: "assistant",
      sequence: 3,
      prompt_tokens: 0,
    });
    insert(db, {
      id: "billed",
      chat_id: "c1",
      role: "assistant",
      sequence: 2,
      prompt_tokens: 50_000,
      cost: 0.05,
    });

    expect(readLastTurnUsage(db, "c1")?.messageId).toBe("billed");
  });

  it("rolls the chat up over billed turns only, and scopes by chat", () => {
    const db = openDb();
    for (const [id, chat, tokens, cost] of [
      ["a", "c1", 10_000, 0.01],
      ["b", "c1", 20_000, 0.02],
      ["c", "c2", 90_000, 0.9],
    ] as const) {
      insert(db, {
        id,
        chat_id: chat,
        role: "assistant",
        sequence: 1,
        prompt_tokens: tokens,
        cost,
      });
    }

    const totals = readChatUsageTotals(db, "c1");
    expect(totals.turns).toBe(2);
    expect(totals.promptTokens).toBe(30_000);
    expect(totals.cost).toBeCloseTo(0.03, 6);
  });

  it("reports zeroes for a chat with no turns rather than throwing", () => {
    const db = openDb();
    expect(readLastTurnUsage(db, "nope")).toBeNull();
    expect(readChatUsageTotals(db, "nope")).toEqual({
      turns: 0,
      cost: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
    });
  });
});
