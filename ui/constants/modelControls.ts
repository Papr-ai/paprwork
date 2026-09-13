/**
 * Per-chat model controls: thinking, effort, context, fast.
 *
 * These four knobs decide what a turn costs, and until now none of them were
 * reachable from the composer. Two consequences fell out of that:
 *
 * 1. Effort was expressed by shipping a *separate model* per level —
 *    `gpt-5-6-sol-low` / `gpt-5-6-sol` / `gpt-5-6-sol-high` are one API model
 *    (`gpt-5.6-sol`) with three different `reasoning.effort` values, and the
 *    picker listed all three as if they were different models. The variant ids
 *    are packaging, not models; {@link EFFORT_VARIANT_MODELS} unpacks them.
 *
 * 2. Context was whatever the model advertised. On a 1M-window model the
 *    history budget computes to ~636K tokens, and every token in that budget is
 *    re-sent on every step of a turn that can run to 100 steps. The window is
 *    not a price tier — Anthropic dropped the >200K surcharge in March 2026 —
 *    but input is billed per token, so the budget is a spend dial either way.
 *
 * Capability is derived from the model rather than hand-listed per control, so
 * a row is only ever offered when the underlying request can actually carry it.
 */

import type { ReasoningEffort } from "../../src/core/types/agents";
import { anthropicModelUsesAdaptiveThinking } from "../../src/gateway/utils/anthropicAdaptiveThinking";
import type { AIModel } from "./models";

export type EffortLevel = ReasoningEffort;

/** Ordered low → high. `max` is offered only where the provider accepts it. */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "max",
];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "High",
  max: "Max",
};

/**
 * Context choices, in tokens.
 *
 * The floor is 200K deliberately: a real turn carries ~86K of tool schemas
 * before any conversation, so anything lower starves the tools it is meant to
 * be budgeting for.
 */
export const CONTEXT_OPTIONS: readonly number[] = [200_000, 400_000, 1_000_000];

/** What a chat gets when the user has never touched the control. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

export function formatContextLimit(tokens: number): string {
  return tokens >= 1_000_000
    ? `${tokens / 1_000_000}M`
    : `${Math.round(tokens / 1000)}K`;
}

/**
 * Retired picker ids that were really one model at a fixed effort.
 *
 * Each maps to the base model plus the effort it always implied, so a chat
 * pinned to `gpt-5-6-sol-high` keeps running at high effort after the picker
 * stops listing it as its own row.
 */
export const EFFORT_VARIANT_MODELS: Readonly<
  Record<string, { modelId: string; effort: EffortLevel }>
> = {
  "gpt-5-6-sol-low": { modelId: "gpt-5-6-sol", effort: "low" },
  "gpt-5-6-sol-high": { modelId: "gpt-5-6-sol", effort: "high" },
  "gpt-5.5-low": { modelId: "gpt-5-6-sol", effort: "low" },
  "gpt-5.5": { modelId: "gpt-5-6-sol", effort: "medium" },
  "gpt-5.5-high": { modelId: "gpt-5-6-sol", effort: "high" },
  "glm-5.2-max": { modelId: "glm-5.2", effort: "max" },
};

/** Base model + implied effort for a possibly-variant id. */
export function unpackEffortVariant(modelId: string): {
  modelId: string;
  effort?: EffortLevel;
} {
  const variant = EFFORT_VARIANT_MODELS[modelId];
  return variant ? { ...variant } : { modelId };
}

/** Providers whose requests carry a reasoning-effort field. */
const EFFORT_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openai-codex",
  "zai",
  "groq",
  "moonshot",
]);

/** Non-Anthropic providers that accept `max` rather than topping out at `high`. */
const MAX_EFFORT_PROVIDERS = new Set(["zai", "moonshot"]);

/**
 * Anthropic tops out at `max` only on the frontier adaptive models.
 *
 * Mirrors the gateway's own `xhigh -> max` mapping, which promotes only Fable
 * and Opus 5; everything else resolves to `high`.
 */
function anthropicAcceptsMaxEffort(modelId: string): boolean {
  return modelId.includes("fable") || modelId.includes("opus-5");
}

/**
 * Anthropic fast mode is API-key only and Opus-5 class only.
 *
 * pi-ai has no `speed` parameter, so an OAuth turn silently ignores it —
 * showing the row there would promise something the request cannot carry.
 * It is also the one control that costs *more* ($10/$50 per M against $5/$25).
 */
const FAST_MODEL_IDS = new Set(["claude-opus-5", "claude-opus-4-8"]);

/**
 * Providers whose request has an actual off switch for reasoning.
 *
 * Anthropic takes `thinking: { type: "disabled" }`, Google a zero thinking
 * budget, Ollama `think: false`. OpenAI-compatible reasoning models have no
 * such field — reasoning is intrinsic and effort is the only dial — so a
 * toggle there would be a switch wired to nothing.
 */
const THINKING_TOGGLE_PROVIDERS = new Set(["anthropic", "google", "ollama"]);

export function modelSupportsThinking(model: AIModel): boolean {
  return model.supportsThinking === true;
}

export function modelSupportsThinkingToggle(model: AIModel): boolean {
  return (
    modelSupportsThinking(model) &&
    THINKING_TOGGLE_PROVIDERS.has(model.provider)
  );
}

export function modelSupportsEffort(model: AIModel): boolean {
  if (!modelSupportsThinking(model)) return false;
  // On Anthropic, effort is part of the *adaptive* thinking surface. The
  // budget-thinking models (Sonnet 4.6, Haiku 4.5, Opus 4.6) take
  // `thinking: { type: "enabled", budgetTokens }` and have no effort field, so
  // offering the row there would send a parameter the request cannot carry.
  if (model.provider === "anthropic") {
    return anthropicModelUsesAdaptiveThinking(model.id);
  }
  return EFFORT_PROVIDERS.has(model.provider);
}

export function modelSupportsFast(
  model: AIModel,
  authType: "oauth" | "apiKey" | undefined,
): boolean {
  return (
    model.provider === "anthropic" &&
    FAST_MODEL_IDS.has(model.id) &&
    authType === "apiKey"
  );
}

/** Effort levels this model will actually honour, low → high. */
export function effortLevelsForModel(model: AIModel): EffortLevel[] {
  const levels: EffortLevel[] = ["low", "medium", "high"];
  const acceptsMax =
    model.provider === "anthropic"
      ? anthropicAcceptsMaxEffort(model.id)
      : MAX_EFFORT_PROVIDERS.has(model.provider);
  if (acceptsMax) {
    levels.push("max");
  }
  return levels;
}

/**
 * Context window per model, in tokens.
 *
 * These mirror the gateway's own registry (`ModelFallback`), which is the value
 * the request is actually budgeted against. They are restated here because the
 * renderer cannot import that module — its relative imports carry `.js`
 * specifiers that the Vite build does not resolve back to `.ts`. A drift test
 * asserts the two stay equal, so the copy cannot quietly go stale.
 */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "claude-haiku-4-5": 200_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-fable-5-1": 1_000_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5-6-luna": 1_050_000,
  "gpt-5-6-terra": 1_050_000,
  "gpt-5-6-sol": 1_050_000,
  "gpt-5.5": 1_000_000,
  "gpt-5.3-codex": 128_000,
  "gemini-3.5-flash-lite": 1_048_576,
  "gemini-3.8-flash": 1_048_576,
  "gemini-3.1-pro-preview": 1_048_576,
  "glm-5.2": 1_000_000,
  "qwen/qwen3-32b": 131_072,
  "openai/gpt-oss-120b": 131_072,
  "kimi-k3": 1_048_576,
};

/** Advertised window, or undefined when the model is not in the table. */
export function contextWindowForModel(model: AIModel): number | undefined {
  return MODEL_CONTEXT_WINDOWS[model.id];
}

/** Context choices that fit inside the model's own window. */
export function contextOptionsForModel(model: AIModel): number[] {
  const window = contextWindowForModel(model);
  if (!window) {
    return [...CONTEXT_OPTIONS];
  }
  const fitting = CONTEXT_OPTIONS.filter((option) => option <= window);
  // A model narrower than the smallest option still needs one honest choice.
  return fitting.length > 0 ? fitting : [window];
}

export function modelSupportsContextChoice(model: AIModel): boolean {
  return contextOptionsForModel(model).length > 1;
}
