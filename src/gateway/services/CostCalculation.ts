/**
 * Cost Calculation - Calculate USD cost from token usage
 *
 * Pricing checked against the provider pricing pages on 2026-11-17 (per 1M
 * tokens). A weekly drift check compares this table with those pages and opens
 * a `pricing-drift` issue when they disagree — see issue #900.
 *
 * Sources:
 *   https://docs.anthropic.com/en/docs/about-claude/pricing.md
 *   https://developers.openai.com/api/docs/pricing
 *   https://ai.google.dev/gemini-api/docs/pricing
 */

import { resolveStepContextTokens } from "./agent/stepContextTokens.js";

export interface ModelPricing {
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
  /**
   * Cache-read rate as a multiple of `input`, where the model departs from the
   * usual 0.1×. Opus 5.5 reads at 0.05× — leaving it on the default would bill
   * cache reads at twice their real rate, and cache read is the single largest
   * component of Anthropic spend (Issue 90), so the error would not be small.
   */
  cacheReadMultiplier?: number;
  /** Cache-write rate as a multiple of `input`, where it is not the usual 1.25×. */
  cacheWriteMultiplier?: number;
  /**
   * Last day (UTC, inclusive, YYYY-MM-DD) the rates above apply. From the next
   * day `then` replaces them. Intro and promo prices used to live in comments,
   * so they never expired in the arithmetic and every turn after the end date
   * was under-reported until someone noticed and edited the table.
   */
  until?: string;
  then?: PricingRates;
}

export type PricingRates = Omit<ModelPricing, "until" | "then">;

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Model pricing table (USD per 1M tokens). Keep each entry on one line: the
 * weekly drift check reads this file as text.
 * Updated: 2026-11-17
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI GPT-5.x (API format uses dots)
  "gpt-5-mini": { input: 0.1, output: 0.4 }, // legacy id; normalizer maps to gpt-5.4-mini
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.3-codex": { input: 15.0, output: 45.0 },
  // GPT-5.6 Series (released July 2026). Cached input is 0.1× on all three.
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-terra": { input: 2.0, output: 12.0 },
  // Sol is on promotional pricing through 2026-11-30 and OpenAI has not
  // published the rate after it, so there is no `then`: the drift check flags
  // the change when the page updates.
  "gpt-5.6-sol": { input: 4.0, output: 20.0 },
  "gpt-5.6-sol-low": { input: 4.0, output: 20.0 },
  "gpt-5.6-sol-high": { input: 4.0, output: 20.0 },
  "gpt-5.6-sol-xhigh": { input: 4.0, output: 20.0 },
  "gpt-5.6": { input: 4.0, output: 20.0 },
  // GPT-6 Astra (released September 2026). Cache read $1 and cache write
  // $12.50 against $10 input are exactly the 0.1× / 1.25× defaults, so no
  // override. Known gap: OpenAI charges 2× input and 1.5× output above 272K
  // input tokens and this table has no tiering, so a turn past that threshold
  // is under-reported. Anthropic has no such tier (see Issue 94).
  "gpt-6-astra": { input: 10.0, output: 50.0 },
  // GPT-5.5 Series (deprecated picker IDs — normalizeOpenAIModelId sends these to
  // gpt-5.6-sol, so they are billed at Sol rates)
  "gpt-5.5-low": { input: 4.0, output: 20.0 },
  "gpt-5.5": { input: 4.0, output: 20.0 },
  "gpt-5.5-high": { input: 4.0, output: 20.0 },
  "gpt-5.5-xhigh": { input: 4.0, output: 20.0 },
  "gpt-5.5-pro": { input: 30.0, output: 180.0 },
  // Deprecated picker IDs / legacy logs (treated as GPT-5.5 tier for forward compatibility)
  "gpt-5.4-low": { input: 4.0, output: 20.0 },
  "gpt-5.4": { input: 4.0, output: 20.0 },
  "gpt-5.4-high": { input: 4.0, output: 20.0 },
  "gpt-5.4-xhigh": { input: 4.0, output: 20.0 },
  "gpt-5.4-pro": { input: 4.0, output: 20.0 },
  "gpt-5.2-low": { input: 4.0, output: 20.0 },
  "gpt-5.2": { input: 4.0, output: 20.0 },
  "gpt-5.2-high": { input: 4.0, output: 20.0 },
  "gpt-5.2-xhigh": { input: 4.0, output: 20.0 },
  "gpt-5.2-codex": { input: 15.0, output: 45.0 },

  // Anthropic Claude 4 Series
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  // $2/$10 was launch pricing; Anthropic made it the standard price and
  // cancelled the scheduled move to $3/$15.
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  // Sonnet 5.5 reads cache at $0.10/M against $2/M input (0.05×).
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheReadMultiplier: 0.05 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-opus-4-5-thinking": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 }, // deprecated — migrated to opus-5-5
  "claude-opus-5": { input: 5.0, output: 25.0 }, // deprecated — migrated to opus-5-5
  // Opus 5.5 reads cache at $0.20/M against $4/M input — Anthropic documents it
  // as "0.05x the base input price", half the rate every other model charges.
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheReadMultiplier: 0.05 },
  // Fable 5.1 reads cache at $0.25/M against $10/M input (0.025×).
  "claude-fable-5-1": { input: 10.0, output: 50.0, cacheReadMultiplier: 0.025 },
  // Fable 5.2 cache read at $0.20/M against $8/M input — 0.025x (Anthropic pricing page)
  "claude-fable-5-2": { input: 8.0, output: 40.0, cacheReadMultiplier: 0.025 },
  "claude-fable-5": { input: 10.0, output: 50.0 }, // deprecated — migrated to fable-5-1 (cache read $1 = 0.1×)

  // Google Gemini Series (API format uses dots: gemini-2.5)
  // Source: https://ai.google.dev/gemini-api/docs/pricing
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, until: "2026-12-31", then: { input: 1.5, output: 7.5 } },
  "gemini-3.7-flash": { input: 1.5, output: 7.5 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, until: "2026-12-31", then: { input: 1.5, output: 7.5 } },
  // Context caching is $0.10 on $2 (and $0.20 on $4 after the intro): 0.05×.
  "gemini-4-argon": { input: 2.0, output: 10.0, cacheReadMultiplier: 0.05, until: "2026-11-30", then: { input: 4.0, output: 20.0, cacheReadMultiplier: 0.05 } },
  "gemini-4-carbon": { input: 2.0, output: 10.0, cacheReadMultiplier: 0.05, until: "2026-11-30", then: { input: 4.0, output: 20.0, cacheReadMultiplier: 0.05 } },
  "gemini-4-neon": { input: 3.0, output: 15.0, cacheReadMultiplier: 0.05 },
  "gemini-4-hydrogen": { input: 1.5, output: 7.5, cacheReadMultiplier: 0.05 },
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
  // Deprecated IDs — kept for cost lookup on older chats
  "gemini-3-flash-preview": { input: 0.5, output: 3.0 },
  "gemini-3-pro-preview": { input: 2.5, output: 10.0 },

  // Ollama (local inference — no per-token API charge)
  "qwen3.5:0.8b": { input: 0, output: 0 },
  "qwen3.5:2b": { input: 0, output: 0 },
  "qwen3.5:4b": { input: 0, output: 0 },
  "qwen3.5:latest": { input: 0, output: 0 },
  "qwen3.5:27b": { input: 0, output: 0 },
  "flint:latest": { input: 0, output: 0 },
  "flint:40b": { input: 0, output: 0 },
  "inkling-2-mini:latest": { input: 0, output: 0 },
  "inkling-2-mini:26b-a5b": { input: 0, output: 0 },
  "gemma4:e2b": { input: 0, output: 0 },
  "gemma4:e4b": { input: 0, output: 0 },
  "gemma4:12b": { input: 0, output: 0 },
  "gemma4:26b": { input: 0, output: 0 },
  "gemma3:270m": { input: 0, output: 0 },
  "gemma3:1b": { input: 0, output: 0 },
  "gemma3:4b": { input: 0, output: 0 },
  "gemma3:latest": { input: 0, output: 0 },
  "gemma3:12b": { input: 0, output: 0 },
  "gemma3:27b": { input: 0, output: 0 },

  // Z.ai GLM (via Papr proxy — upstream API rates)
  "glm-5.2": { input: 1.4, output: 4.4 },
  "glm-5.2-max": { input: 1.4, output: 4.4 },

  // Groq (via Papr proxy — https://groq.com/pricing, uncached input rates)
  "qwen/qwen3-32b": { input: 0.29, output: 0.59 },
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },

  // Moonshot Kimi K3 (via Papr proxy — cache-miss input / output per 1M tokens)
  "kimi-k3": { input: 3.0, output: 15.0 },
  "kimi-3": { input: 3.0, output: 15.0 },
};

/**
 * Rates in force at `at`. An entry past its `until` date answers with its
 * `then` rates; anything else answers as written.
 */
export function resolveModelPricing(
  model: string,
  at: Date = new Date(),
): PricingRates | undefined {
  const entry =
    MODEL_PRICING[normalizeModelForPricing(model)] ?? MODEL_PRICING[model];
  if (!entry) return undefined;
  const { until, then, ...current } = entry;
  if (until && then && at.getTime() >= endOfUtcDay(until)) return then;
  return current;
}

/** First instant after the given UTC calendar day. */
function endOfUtcDay(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) + 86_400_000;
}

/** Normalize model ID for cost lookup (legacy dash format -> dot format) */
function normalizeModelForPricing(model: string): string {
  return model
    .replace(/gpt-5-2/g, "gpt-5.2")
    .replace(/gpt-5-4/g, "gpt-5.4")
    .replace(/gpt-5-5/g, "gpt-5.5")
    .replace(/gpt-5-6/g, "gpt-5.6")
    .replace(/gemini-2-5/g, "gemini-2.5");
}

export interface TokenUsageForCost {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Anthropic/OpenAI prompt cache: read ≈ 0.1× input, write ≈ 1.25× input */
export const CACHE_READ_COST_MULTIPLIER = 0.1;
export const CACHE_WRITE_COST_MULTIPLIER = 1.25;

/**
 * Input tokens that were neither read from nor written to the prompt cache.
 *
 * A cached token is part of the prompt, not an extra charge beside it: Anthropic,
 * OpenAI and Google all report a prompt total that *contains* the cached portion
 * (`@ai-sdk/anthropic` 3.x maps `inputTokens` to
 * `input + cacheCreationTokens + cacheReadTokens`). Billing the reported total at
 * full price and then adding the cache figures on top therefore charges the same
 * tokens twice — which is what happened here, overstating September's Anthropic
 * spend 5.8× and hitting well-cached turns hardest, since a cache *read* is the
 * cheapest token there is and was being re-billed at 1.0×.
 *
 * The convention is detected rather than assumed, reusing
 * {@link resolveStepContextTokens}: a comment asserting one convention is what
 * produced the doubling, and the SDK had already changed underneath it. That
 * helper returns the true prompt total under either convention, so subtracting
 * the cached portion yields the uncached remainder under either one.
 */
function resolveUncachedPromptTokens(
  promptTokens: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const cached = cacheRead + cacheWrite;
  const total = resolveStepContextTokens({
    inputTokens: promptTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  });
  return Math.max(0, total - cached);
}

/**
 * Calculate USD cost with prompt-cache token breakdown.
 *
 * Cache reads bill at 0.1× input and writes at 1.25× (unless the model
 * overrides them); the remaining uncached input bills at 1.0×. `at` picks the
 * rates in force at that moment — callers pricing a stored turn pass its
 * timestamp. When cache tokens are 0, equivalent to {@link calculateCost}.
 *
 * Known gap: Anthropic bills 1-hour cache writes at 2× input, and the system
 * prompt is cached with a 1h TTL. Providers report one combined cache-write
 * count, so every write is priced at the 5-minute rate here (issue #900).
 */
export function calculateCostWithCache(
  model: string,
  usage: TokenUsageForCost,
  at: Date = new Date(),
): number {
  const pricing = resolveModelPricing(model, at);
  if (!pricing) {
    console.warn(
      `[CostCalculation] Unknown model: ${model}, cost calculation unavailable`,
    );
    return 0;
  }

  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  const promptTokens = Math.max(0, usage.promptTokens);
  const completionTokens = Math.max(0, usage.completionTokens);

  const uncachedPromptTokens = resolveUncachedPromptTokens(
    promptTokens,
    cacheRead,
    cacheWrite,
  );

  const cacheReadMultiplier =
    pricing.cacheReadMultiplier ?? CACHE_READ_COST_MULTIPLIER;
  const cacheWriteMultiplier =
    pricing.cacheWriteMultiplier ?? CACHE_WRITE_COST_MULTIPLIER;

  const inputCost =
    (uncachedPromptTokens / 1_000_000) * pricing.input +
    (cacheRead / 1_000_000) * pricing.input * cacheReadMultiplier +
    (cacheWrite / 1_000_000) * pricing.input * cacheWriteMultiplier;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * Calculate cost for a single model response
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  return calculateCostWithCache(model, { promptTokens, completionTokens });
}

/**
 * Calculate detailed cost breakdown
 */
export function calculateCostBreakdown(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): CostBreakdown {
  const pricing = resolveModelPricing(model);
  const inputCost = pricing
    ? calculateCostWithCache(model, {
        promptTokens,
        completionTokens: 0,
        cacheReadTokens,
        cacheWriteTokens,
      })
    : 0;
  const outputCost = pricing
    ? (completionTokens / 1_000_000) * pricing.output
    : 0;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    model,
    promptTokens,
    completionTokens,
  };
}

/**
 * Format cost for display
 */
export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`; // Show 4 decimals for tiny costs
  if (cost < 1) return `$${cost.toFixed(3)}`; // Show 3 decimals for cents
  return `$${cost.toFixed(2)}`; // Show 2 decimals for dollars
}

/**
 * Get cost tier for visualization
 */
export function getCostTier(
  cost: number,
): "low" | "medium" | "high" | "very-high" {
  if (cost < 0.1) return "low"; // < 10 cents
  if (cost < 0.5) return "medium"; // 10-50 cents
  if (cost < 2.0) return "high"; // 50 cents - $2
  return "very-high"; // > $2
}

/**
 * Estimate cost for future usage
 */
export function estimateMonthlyCost(
  avgCostPerRun: number,
  runsPerDay: number,
): number {
  return avgCostPerRun * runsPerDay * 30; // 30-day month
}

/**
 * Calculate cost savings from model switch
 */
export function calculateSavings(
  currentModel: string,
  proposedModel: string,
  avgPromptTokens: number,
  avgCompletionTokens: number,
  runsPerMonth: number,
): {
  currentMonthlyCost: number;
  proposedMonthlyCost: number;
  monthlySavings: number;
  savingsPercentage: number;
} {
  const currentCost = calculateCost(
    currentModel,
    avgPromptTokens,
    avgCompletionTokens,
  );
  const proposedCost = calculateCost(
    proposedModel,
    avgPromptTokens,
    avgCompletionTokens,
  );

  const currentMonthlyCost = currentCost * runsPerMonth;
  const proposedMonthlyCost = proposedCost * runsPerMonth;
  const monthlySavings = currentMonthlyCost - proposedMonthlyCost;
  const savingsPercentage =
    currentMonthlyCost > 0 ? (monthlySavings / currentMonthlyCost) * 100 : 0;

  return {
    currentMonthlyCost,
    proposedMonthlyCost,
    monthlySavings,
    savingsPercentage,
  };
}
