import { describe, expect, it } from "vitest";
import { addTurnUsage } from "../src/gateway/services/agent/turnUsageAccounting.js";

/**
 * Shapes taken from a real continued turn: a long first stream on claude-opus-5,
 * then a plan continuation that reported a small total of its own.
 */
const FIRST_STREAM = {
  promptTokens: 40,
  completionTokens: 12_744,
  totalTokens: 1_932_307,
  cacheReadTokens: 1_919_523,
  cacheWriteTokens: 0,
};

const CONTINUATION = {
  promptTokens: 12,
  completionTokens: 830,
  totalTokens: 61_842,
  cacheReadTokens: 61_000,
  cacheWriteTokens: 0,
};

describe("addTurnUsage", () => {
  it("adds a continuation's total instead of replacing the turn's", () => {
    const merged = addTurnUsage(FIRST_STREAM, CONTINUATION)!;

    expect(merged.totalTokens).toBe(1_932_307 + 61_842);
    expect(merged.completionTokens).toBe(12_744 + 830);
    expect(merged.cacheReadTokens).toBe(1_919_523 + 61_000);
  });

  it("does not lose the first stream when the continuation reports zeros", () => {
    // The regression: last-value-wins turned a $1.80 turn into a $0.00 turn.
    const zeroed = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    const merged = addTurnUsage(FIRST_STREAM, zeroed)!;
    expect(merged.totalTokens).toBe(FIRST_STREAM.totalTokens);
    expect(merged.cacheReadTokens).toBe(FIRST_STREAM.cacheReadTokens);
  });

  it("returns the running stream when nothing is committed yet", () => {
    expect(addTurnUsage(undefined, FIRST_STREAM)).toEqual(FIRST_STREAM);
  });

  it("returns the committed total when a continuation reports nothing at all", () => {
    expect(addTurnUsage(FIRST_STREAM, undefined)).toEqual(FIRST_STREAM);
  });

  it("is undefined only when neither side reported", () => {
    expect(addTurnUsage(undefined, undefined)).toBeUndefined();
  });

  it("accumulates across three streams, since a turn can continue twice", () => {
    const once = addTurnUsage(FIRST_STREAM, CONTINUATION);
    const twice = addTurnUsage(once, CONTINUATION)!;

    expect(twice.totalTokens).toBe(1_932_307 + 61_842 * 2);
  });

  it("keeps cache fields absent when neither side reported them", () => {
    // Absent must not become 0: billing substitutes a tracked fallback for absent,
    // and a literal 0 would suppress that fallback.
    const a = { promptTokens: 5, completionTokens: 6, totalTokens: 11 };
    const b = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

    const merged = addTurnUsage(a, b)!;
    expect(merged.cacheReadTokens).toBeUndefined();
    expect(merged.cacheWriteTokens).toBeUndefined();
  });

  it("treats one reported side as that side's value, not as zero", () => {
    const reported = {
      promptTokens: 5,
      completionTokens: 6,
      totalTokens: 11,
      cacheReadTokens: 900,
    };
    const unreported = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

    expect(addTurnUsage(reported, unreported)!.cacheReadTokens).toBe(900);
    expect(addTurnUsage(unreported, reported)!.cacheReadTokens).toBe(900);
  });

  it("does not mutate either input", () => {
    const committed = { ...FIRST_STREAM };
    const current = { ...CONTINUATION };
    addTurnUsage(committed, current);

    expect(committed).toEqual(FIRST_STREAM);
    expect(current).toEqual(CONTINUATION);
  });
});
