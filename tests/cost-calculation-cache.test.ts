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

/**
 * Providers report a prompt total that already contains the cached portion, so
 * billing that total at 1.0× and then adding the cache figures charges the same
 * tokens twice.
 *
 * The cases below are two real consecutive turns from chat 01eed089 on
 * 2026-09-11 (claude-opus-5, $5/$25 per 1M). The `stored` figures are what the
 * old arithmetic wrote to `messages.cost` — reproduced here to the cent, because
 * a regression would have to reproduce them again to pass.
 *
 * Note the shape of the error: it is worst on the *well-cached* turn. The 7-step
 * turn was overstated 10.2× and the single-step cache miss only 1.8×, so the
 * recorded data ranked a healthy turn as the expensive one.
 */
describe("calculateCostWithCache — cached tokens are not billed twice", () => {
  const OPUS = "claude-opus-5";

  test("total cache miss: only the 2 genuinely uncached tokens bill at 1.0×", () => {
    const cost = calculateCostWithCache(OPUS, {
      promptTokens: 341_471,
      completionTokens: 941,
      cacheReadTokens: 0,
      cacheWriteTokens: 341_469,
    });

    // 2 uncached @ $5 + 341,469 write @ $6.25 + 941 out @ $25
    expect(cost).toBeCloseTo(2.15771625, 8);

    const stored = 3.86506125;
    expect(cost).toBeLessThan(stored);
  });

  test("near-full cache hit: the read is not re-billed at full price", () => {
    const cost = calculateCostWithCache(OPUS, {
      promptTokens: 388_080,
      completionTokens: 340,
      cacheReadTokens: 386_581,
      cacheWriteTokens: 1_497,
    });

    // 2 uncached @ $5 + 386,581 read @ $0.50 + 1,497 write @ $6.25 + 340 out @ $25
    expect(cost).toBeCloseTo(0.21115675, 8);

    const stored = 2.15154675;
    expect(stored / cost).toBeGreaterThan(10);
  });

  test("reading the whole prompt from cache costs exactly 0.1× not 1.1×", () => {
    const tokens = 100_000;

    const uncached = calculateCostWithCache(OPUS, {
      promptTokens: tokens,
      completionTokens: 0,
    });
    const fullyCached = calculateCostWithCache(OPUS, {
      promptTokens: tokens,
      completionTokens: 0,
      cacheReadTokens: tokens,
    });

    expect(fullyCached / uncached).toBeCloseTo(CACHE_READ_COST_MULTIPLIER, 8);
  });

  test("the exclusive convention is still honoured when input is the remainder", () => {
    // A provider reporting only fresh tokens: input < cached, so nothing is
    // subtracted and the remainder bills in full.
    const cost = calculateCostWithCache(OPUS, {
      promptTokens: 1_000,
      completionTokens: 0,
      cacheReadTokens: 5_000,
    });

    // 1,000 @ $5 + 5,000 @ $0.50
    expect(cost).toBeCloseTo(0.005 + 0.0025, 8);
  });

  test("cost never goes negative when cache figures exceed the total", () => {
    const cost = calculateCostWithCache(OPUS, {
      promptTokens: 22,
      completionTokens: 0,
      cacheReadTokens: 2_274_371,
      cacheWriteTokens: 175_819,
    });

    expect(cost).toBeGreaterThan(0);
  });
});
