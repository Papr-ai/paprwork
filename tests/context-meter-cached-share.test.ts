import { describe, expect, it } from "vitest";
import {
  computeTurnCachedInputShare,
  formatCachedInputShare,
  resolveStepContextTokensForTurn,
} from "../ui/components/Chat/contextMeterModel";

describe("computeTurnCachedInputShare", () => {
  it("returns null when no cache tokens were reported", () => {
    expect(
      computeTurnCachedInputShare({
        promptTokens: 50_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });

  it("does not divide cache reads by a tiny prompt total (multi-step Anthropic)", () => {
    const share = computeTurnCachedInputShare({
      promptTokens: 22,
      cacheReadTokens: 756_000,
      cacheWriteTokens: 0,
    });
    expect(share).not.toBeNull();
    expect(share!).toBeGreaterThan(0.99);
    expect(share!).toBeLessThanOrEqual(1);
    expect(formatCachedInputShare({
      promptTokens: 22,
      cacheReadTokens: 756_000,
      cacheWriteTokens: 0,
    })).toBe("100%");
  });

  it("uses inclusive prompt totals when input already contains cache", () => {
    const share = computeTurnCachedInputShare({
      promptTokens: 100_000,
      cacheReadTokens: 90_000,
      cacheWriteTokens: 0,
    });
    expect(share).toBeCloseTo(0.9, 5);
  });

  it("never exceeds 100% in formatted output", () => {
    const formatted = formatCachedInputShare({
      promptTokens: 1_000,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 0,
    });
    const pct = Number.parseInt(formatted, 10);
    expect(pct).toBeLessThanOrEqual(100);
    expect(pct).toBeGreaterThan(0);
  });
});

describe("resolveStepContextTokensForTurn", () => {
  it("adds cache figures when prompt total is exclusive", () => {
    expect(
      resolveStepContextTokensForTurn({
        inputTokens: 22,
        cacheReadTokens: 80_000,
      }),
    ).toBe(80_022);
  });
});
