import { describe, expect, test } from "vitest";
import {
  CACHE_READ_COST_MULTIPLIER,
  CACHE_WRITE_COST_MULTIPLIER,
  calculateCost,
  calculateCostWithCache,
} from "../src/gateway/services/CostCalculation.js";

describe("calculateCostWithCache", () => {
  test("matches calculateCost when no cache tokens", () => {
    const plain = calculateCost("claude-sonnet-4-6", 10_000, 2_000);
    const withCache = calculateCostWithCache("claude-sonnet-4-6", {
      promptTokens: 10_000,
      completionTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(withCache).toBe(plain);
  });

  test("cache read is cheaper than full input (all models)", () => {
    const models = [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gpt-5.5",
      "gemini-2.5-flash",
    ] as const;

    for (const model of models) {
      const fullInput = calculateCostWithCache(model, {
        promptTokens: 3_750,
        completionTokens: 0,
      });
      const cacheRead = calculateCostWithCache(model, {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 3_750,
      });
      expect(cacheRead).toBeCloseTo(fullInput * CACHE_READ_COST_MULTIPLIER, 8);
      expect(cacheRead).toBeLessThan(fullInput);
    }
  });

  test("15KB file scenario: full+cache beats 5 re-reads (~3×)", () => {
    const model = "claude-opus-4-6";
    const tokens = 3_750;

    const fullWithCache =
      calculateCostWithCache(model, {
        promptTokens: 0,
        completionTokens: 0,
        cacheWriteTokens: tokens,
      }) +
      4 *
        calculateCostWithCache(model, {
          promptTokens: 0,
          completionTokens: 0,
          cacheReadTokens: tokens,
        });

    const strategyB = 5 * calculateCostWithCache(model, {
      promptTokens: tokens,
      completionTokens: 0,
    });

    expect(strategyB / fullWithCache).toBeCloseTo(3.0, 1);
  });

  test("cache write costs 1.25× input", () => {
    const inputOnly = calculateCostWithCache("gpt-5.5", {
      promptTokens: 1_000,
      completionTokens: 0,
    });
    const cacheWrite = calculateCostWithCache("gpt-5.5", {
      promptTokens: 0,
      completionTokens: 0,
      cacheWriteTokens: 1_000,
    });
    expect(cacheWrite).toBeCloseTo(inputOnly * CACHE_WRITE_COST_MULTIPLIER, 8);
  });
});
