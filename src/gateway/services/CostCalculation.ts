/**
 * Cost Calculation - Calculate USD cost from token usage
 *
 * Pricing as of 2026-04-24 (per 1M tokens)
 */

export interface ModelPricing {
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Model pricing table (USD per 1M tokens)
 * Updated: 2026-04-24
 * Source: Official pricing pages
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI GPT-5.x (API format uses dots)
  "gpt-5-mini": { input: 0.1, output: 0.4 }, // legacy id; normalizer maps to gpt-5.4-mini
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.3-codex": { input: 15.0, output: 45.0 },
  // GPT-5.6 Series (released July 2026)
  "gpt-5.6-luna": { input: 1.0, output: 6.0 },
  "gpt-5.6-terra": { input: 2.5, output: 15.0 },
  "gpt-5.6-sol": { input: 5.0, output: 30.0 },
  "gpt-5.6-sol-low": { input: 5.0, output: 30.0 },
  "gpt-5.6-sol-high": { input: 5.0, output: 30.0 },
  "gpt-5.6-sol-xhigh": { input: 5.0, output: 30.0 },
  "gpt-5.6": { input: 5.0, output: 30.0 },
  // GPT-5.5 Series (deprecated picker IDs — treated as GPT-5.6 Sol tier)
  "gpt-5.5-low": { input: 5.0, output: 30.0 },
  "gpt-5.5": { input: 5.0, output: 30.0 },
  "gpt-5.5-high": { input: 5.0, output: 30.0 },
  "gpt-5.5-xhigh": { input: 5.0, output: 30.0 },
  "gpt-5.5-pro": { input: 30.0, output: 180.0 },
  // Deprecated picker IDs / legacy logs (treated as GPT-5.5 tier for forward compatibility)
  "gpt-5.4-low": { input: 5.0, output: 30.0 },
  "gpt-5.4": { input: 5.0, output: 30.0 },
  "gpt-5.4-high": { input: 5.0, output: 30.0 },
  "gpt-5.4-xhigh": { input: 5.0, output: 30.0 },
  "gpt-5.4-pro": { input: 5.0, output: 30.0 },
  "gpt-5.2-low": { input: 5.0, output: 30.0 },
  "gpt-5.2": { input: 5.0, output: 30.0 },
  "gpt-5.2-high": { input: 5.0, output: 30.0 },
  "gpt-5.2-xhigh": { input: 5.0, output: 30.0 },
  "gpt-5.2-codex": { input: 15.0, output: 45.0 },

  // Anthropic Claude 4 Series
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-opus-4-5-thinking": { input: 15.0, output: 75.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 }, // deprecated — migrated to opus-5
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-fable-5-1": { input: 10.0, output: 50.0 },
  "claude-fable-5": { input: 10.0, output: 50.0 }, // deprecated — migrated to fable-5-1

  // Google Gemini Series (API format uses dots: gemini-2.5)
  // Source: https://ai.google.dev/gemini-api/docs/pricing
  "gemini-2.5-flash-lite": { input: 0.15, output: 0.6 },
  "gemini-2.5-flash": { input: 0.3, output: 1.2 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
  // Deprecated IDs — kept for cost lookup on older chats
  "gemini-3-flash-preview": { input: 0.6, output: 2.4 },
  "gemini-3-pro-preview": { input: 2.5, output: 10.0 },

  // Ollama (local inference — no per-token API charge)
  "qwen3.5:0.8b": { input: 0, output: 0 },
  "qwen3.5:2b": { input: 0, output: 0 },
  "qwen3.5:4b": { input: 0, output: 0 },
  "qwen3.5:latest": { input: 0, output: 0 },
  "qwen3.5:27b": { input: 0, output: 0 },
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
 * Calculate USD cost with prompt-cache token breakdown.
 *
 * `promptTokens` is regular (non-cache) input from the provider.
 * Cache read/write are billed at discounted/premium rates on top.
 * When cache tokens are 0, equivalent to {@link calculateCost}.
 */
export function calculateCostWithCache(
  model: string,
  usage: TokenUsageForCost,
): number {
  const normalized = normalizeModelForPricing(model);
  const pricing = MODEL_PRICING[normalized] ?? MODEL_PRICING[model];
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

  const inputCost =
    (promptTokens / 1_000_000) * pricing.input +
    (cacheRead / 1_000_000) * pricing.input * CACHE_READ_COST_MULTIPLIER +
    (cacheWrite / 1_000_000) * pricing.input * CACHE_WRITE_COST_MULTIPLIER;
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
  const normalized = normalizeModelForPricing(model);
  const pricing = MODEL_PRICING[normalized] ?? MODEL_PRICING[model];
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
