/**
 * Model-aware context budgeting for AI SDK streaming.
 * Keeps in-flight prompts under each model's real context window (tools + output reserved).
 */

import { ModelFallback } from "../../../core/agents/ModelFallback.js";
import type { Provider } from "../../../core/types/agents.js";

const fallback = new ModelFallback();

const PROVIDER_DEFAULT_CONTEXT: Partial<Record<Provider, number>> = {
  groq: 131_072,
  moonshot: 1_048_576,
  ollama: 32_768,
  openai: 128_000,
  anthropic: 200_000,
  google: 1_048_576,
  zai: 128_000,
};

/** Resolve context window for a provider/model pair. */
export function resolveModelContextWindow(
  provider: Provider,
  modelId: string,
): number {
  const info = fallback.getModelInfo(modelId);
  if (info?.contextWindow) {
    return info.contextWindow;
  }
  return PROVIDER_DEFAULT_CONTEXT[provider] ?? 128_000;
}

/** Provider that owns a model id, for callers holding only the id. */
export function resolveProviderForModel(modelId: string): Provider {
  return fallback.getModelInfo(modelId)?.provider ?? "anthropic";
}

/**
 * Smallest window we will budget against, whatever the user asks for.
 *
 * A turn carries ~86K of tool schemas before any conversation, so a cap below
 * this would leave no room for the history it is supposed to be budgeting and
 * every turn would trim to the 8K floor.
 */
export const MIN_CONTEXT_LIMIT = 128_000;

/**
 * Effective window: the model's own, narrowed by the user's choice.
 *
 * A cap can only ever shrink the window — asking for 1M on a 200K model does
 * not widen it — and cannot go below {@link MIN_CONTEXT_LIMIT}.
 */
export function resolveEffectiveContextWindow(
  provider: Provider,
  modelId: string,
  contextLimit?: number,
): number {
  const modelWindow = resolveModelContextWindow(provider, modelId);
  if (!contextLimit || !Number.isFinite(contextLimit) || contextLimit <= 0) {
    return modelWindow;
  }
  return Math.min(modelWindow, Math.max(contextLimit, MIN_CONTEXT_LIMIT));
}

/** Fraction of context window available for message history (rest: tools + output). */
const HISTORY_BUDGET_RATIO = 0.85;

/** Output reserve when maxTokens is not set on the request. */
const DEFAULT_OUTPUT_RESERVE = 16_000;

/**
 * Largest share of the effective window that may be held back for output.
 *
 * The reserve arrives as the model's *advertised maximum* output — 128K on
 * opus-5, 131K on several others, straight from the model table — and used to
 * be subtracted in full. Inside a 200K cap that set aside 64% of the window for
 * a reply the turn will almost never write (a measured 7-step turn produced 340
 * output tokens), which drove the budget to -45,363 and floored it at 8K.
 *
 * One third leaves every cap at or above 400K untouched, because 128K is
 * already below a third of 400K. Only windows small enough for the reserve to
 * dominate are affected — which is exactly the case that was broken.
 *
 * This does not rescue every small window: tool schemas are charged separately
 * and can exceed the window on their own (~87K of schemas against a 128K cap),
 * and no output-reserve arithmetic can fix that.
 */
const MAX_OUTPUT_RESERVE_RATIO = 1 / 3;

/**
 * Output reserve for a given window: what the request asked for, capped so it
 * cannot crowd out the history it is being subtracted from.
 */
export function resolveOutputReserve(
  contextWindow: number,
  maxOutputTokens?: number,
): number {
  const requested = maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE;
  return Math.min(
    requested,
    Math.floor(contextWindow * MAX_OUTPUT_RESERVE_RATIO),
  );
}

/**
 * Gemini models advertise a 1M window, but long tool-heavy history degrades quality.
 * Cap message-history budget and trigger summarize/trim above this.
 */
export const GEMINI_HISTORY_TOKEN_CAP = 150_000;

/**
 * Window for any session where no user-chosen cap is supplied.
 *
 * The interactive composer sends its own `contextLimit` (Enhancement 77) and so
 * is unaffected by this. Every *other* caller that streams an agent has no
 * control to send one — background jobs, sub-agent replies, app-agent chat —
 * and each was built with the field unset.
 *
 * Unset is not a conservative default, it is the widest possible one:
 * {@link resolveEffectiveContextWindow} then returns the model's *advertised*
 * window, 1M on opus-5. Measured across the same models in one database:
 *
 *   interactive, 200K cap -> history budget  15,971, avg 104,007 tok/request
 *   job, uncapped (1M)    -> history budget 746,637, avg 216,617 tok/request,
 *                            peaking at 290,629
 *
 * A 47x budget gap, and jobs were duly the largest requests we made.
 *
 * The leak is mid-turn, not historical. These sessions open on a fresh chat id
 * (`job:{jobId}:{runId}` and friends) with no prior conversation, so there is
 * almost nothing for the trimmer to remove — what the 746K budget really
 * permitted was unbounded accumulation of *tool results* inside one long turn.
 *
 * 200K matches the interactive default, so both are budgeted against a window
 * we have measured rather than a guess. It cannot go far below: tool schemas
 * alone are ~87K and {@link MIN_CONTEXT_LIMIT} is 128K, at which the budget
 * clamps to its 8K floor and silently stops bounding anything.
 *
 * The resulting history budget is 66,637 — larger than an interactive chat's
 * 15,971 at the same cap, because these callers leave `maxTokens` unset and so
 * take the 16K default output reserve instead of the model's advertised 128K.
 * That asymmetry is deliberate: they carry no conversation but do accumulate
 * tool results across one long turn, so the spare room lands where it is used.
 *
 * Note this is a *budget*, not a price tier. Anthropic bills the full 1M window
 * at standard rates ("a 900k-token request is billed at the same per-token rate
 * as a 9k-token request"), so the saving here is purely in tokens not sent —
 * which is also where the quality saving is, since long tool-heavy context
 * degrades retrieval well before the window fills.
 */
export const DEFAULT_SESSION_CONTEXT_LIMIT = 200_000;

/** Default history-token threshold before proactive summarization (non-Gemini). */
export const DEFAULT_SUMMARIZE_HISTORY_TOKEN_THRESHOLD = 40_000;

export function isGoogleGeminiProvider(provider: Provider): boolean {
  return provider === "google";
}

/** History-token threshold for proactive summarization (provider-aware). */
export function resolveSummarizeHistoryTokenThreshold(
  provider: Provider,
): number {
  if (isGoogleGeminiProvider(provider)) {
    return GEMINI_HISTORY_TOKEN_CAP;
  }
  return DEFAULT_SUMMARIZE_HISTORY_TOKEN_THRESHOLD;
}

/** Re-summarize when Gemini history still exceeds the cap despite an existing summary. */
export function shouldForceGeminiResummarize(
  provider: Provider,
  estimatedHistoryTokens: number,
): boolean {
  return (
    isGoogleGeminiProvider(provider) &&
    estimatedHistoryTokens >= GEMINI_HISTORY_TOKEN_CAP
  );
}

/**
 * Token budget for message history mid-turn (excludes tool schemas and output).
 * Returns at least 8K so trimming still runs on small windows.
 * Google/Gemini: capped at {@link GEMINI_HISTORY_TOKEN_CAP} for quality.
 */
export function computeHistoryTokenBudget(params: {
  provider: Provider;
  modelId: string;
  toolTokenEstimate: number;
  maxOutputTokens?: number;
  /** User-chosen cap; narrows the model's window, never widens it. */
  contextLimit?: number;
}): number {
  const contextWindow = resolveEffectiveContextWindow(
    params.provider,
    params.modelId,
    params.contextLimit,
  );
  const outputReserve = resolveOutputReserve(
    contextWindow,
    params.maxOutputTokens,
  );
  const budget = Math.floor(
    contextWindow * HISTORY_BUDGET_RATIO -
      params.toolTokenEstimate -
      outputReserve,
  );
  let capped = Math.max(budget, 8_000);
  if (isGoogleGeminiProvider(params.provider)) {
    capped = Math.min(capped, GEMINI_HISTORY_TOKEN_CAP);
  }
  return capped;
}

/** Whether an API/stream error indicates the prompt exceeded the model context window. */
export function isContextLengthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("context_length_exceeded") ||
    lower.includes("context length exceeded") ||
    lower.includes("reduce the length of the messages") ||
    lower.includes("maximum context length") ||
    lower.includes("context limit")
  );
}
