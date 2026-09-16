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
 * we have measured rather than a guess.
 *
 * It used to be the case that a 128K window clamped the budget to its 8K floor
 * and silently stopped bounding anything. That is no longer true, and the two
 * reasons are worth keeping: the output reserve is now a third of the window
 * rather than the model's advertised maximum, and the tool block is measured at
 * its real ~38.5K on the wire rather than the ~87K over-estimate. At 128K the
 * budget is now 27,608 — small, but a real budget. (This comment previously
 * read ~87K, which was the over-estimate corrected in `toolSchemaTokens.ts`.)
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

/**
 * Ceiling on the history allowance, independent of how much room the window
 * arithmetic leaves. Applied by {@link resolveHistoryTokenBudget}, which is
 * what a live turn calls — not by `computeHistoryTokenBudget`, for the reason
 * recorded there.
 *
 * Needed because correcting the tool-block measurement *widens* this budget:
 * the old estimate over-stated the block by 2.31x (88,477 against a real
 * 38,526) and the block is subtracted here, so the error was withholding room.
 * At a 400K cap the honest figure raises the budget from 123,523 to 173,474,
 * and deferring unused schemas raises it again.
 *
 * 128,000 is the largest history allowance we have actually run: turns on this
 * workspace recorded budgets of 123,523 (400K cap) and worked. Capping there
 * means no chat is handed more room than has been validated, while the tiers
 * the measurement error had starved — a 200K cap was budgeting 15,971 where the
 * arithmetic intends 64,807 — are allowed to recover.
 *
 * The freed room is only *spent* when there is history to spend it on, so a
 * short chat simply sends 27K fewer tokens; a long one keeps context it was
 * previously trimming away. Raising this is a quality-vs-cost decision and
 * should be evaluated on recorded turn metrics, not adjusted by feel.
 */
export const DEFAULT_HISTORY_TOKEN_CAP = 128_000;

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
export interface HistoryBudgetParams {
  provider: Provider;
  modelId: string;
  toolTokenEstimate: number;
  maxOutputTokens?: number;
  /** User-chosen cap; narrows the model's window, never widens it. */
  contextLimit?: number;
}

export function computeHistoryTokenBudget(
  params: HistoryBudgetParams,
): number {
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
  const capped = Math.max(budget, 8_000);
  if (isGoogleGeminiProvider(params.provider)) {
    return Math.min(capped, GEMINI_HISTORY_TOKEN_CAP);
  }
  return capped;
}

/**
 * The budget a live turn actually uses: the arithmetic above, held to
 * {@link DEFAULT_HISTORY_TOKEN_CAP}.
 *
 * Deliberately *not* folded into `computeHistoryTokenBudget`. A cap at the end
 * of that function is the last word, so it swallows everything upstream: at a
 * 400K cap it would flatten the output-reserve fix (Issue 89) and the Gemini
 * ceiling to the same 128,000, leaving neither guarantee observable through the
 * public function and turning both of their tests into assertions about this
 * constant. Keeping the arithmetic pure and applying the ceiling as caller
 * policy leaves those guards checking what they were written to check.
 */
export function resolveHistoryTokenBudget(
  params: HistoryBudgetParams,
): number {
  return Math.min(
    computeHistoryTokenBudget(params),
    DEFAULT_HISTORY_TOKEN_CAP,
  );
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
