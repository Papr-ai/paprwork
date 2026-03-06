/**
 * Cost Calculation - Calculate USD cost from token usage
 *
 * Pricing as of 2026-02-20 (per 1M tokens)
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
 * Updated: 2026-02-20
 * Source: Official pricing pages
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI GPT-5 Series (API format uses dots: gpt-5.2)
  "gpt-5-mini": { input: 0.1, output: 0.4 },
  "gpt-5.2-low": { input: 2.5, output: 10.0 },
  "gpt-5.2": { input: 5.0, output: 15.0 },
  "gpt-5.2-high": { input: 10.0, output: 30.0 },
  "gpt-5.2-xhigh": { input: 20.0, output: 60.0 },
  "gpt-5.2-codex": { input: 15.0, output: 45.0 },
  "gpt-5.3-codex": { input: 15.0, output: 45.0 },
  "gpt-5.4": { input: 2.5, output: 15.0 }, // GPT-5.4 Thinking
  "gpt-5.4-pro": { input: 30.0, output: 180.0 }, // GPT-5.4 Pro

  // Anthropic Claude 4 Series
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-opus-4-5-thinking": { input: 15.0, output: 75.0 },

  // Google Gemini Series (API format uses dots: gemini-2.5)
  "gemini-2.5-flash-lite": { input: 0.15, output: 0.6 },
  "gemini-2.5-flash": { input: 0.3, output: 1.2 },
  "gemini-3-flash-preview": { input: 0.6, output: 2.4 },
  "gemini-3-pro-preview": { input: 2.5, output: 10.0 },
};

/** Normalize model ID for cost lookup (legacy dash format -> dot format) */
function normalizeModelForPricing(model: string): string {
  return model
    .replace(/gpt-5-2/g, "gpt-5.2")
    .replace(/gemini-2-5/g, "gemini-2.5");
}

/**
 * Calculate cost for a single model response
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const normalized = normalizeModelForPricing(model);
  const pricing = MODEL_PRICING[normalized] ?? MODEL_PRICING[model];
  if (!pricing) {
    console.warn(
      `[CostCalculation] Unknown model: ${model}, cost calculation unavailable`,
    );
    return 0;
  }

  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * Calculate detailed cost breakdown
 */
export function calculateCostBreakdown(
  model: string,
  promptTokens: number,
  completionTokens: number,
): CostBreakdown {
  const normalized = normalizeModelForPricing(model);
  const pricing = MODEL_PRICING[normalized] ?? MODEL_PRICING[model];
  const inputCost = pricing ? (promptTokens / 1_000_000) * pricing.input : 0;
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
