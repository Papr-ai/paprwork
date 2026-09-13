/**
 * Auth-aware model defaults for the chat UI.
 *
 * Global seed: Gemini. OAuth connect bumps global to Sonnet (Claude) or GPT
 * (ChatGPT). Fallback order when resolving without a saved pick:
 * Sonnet → GPT → Gemini (first one the user can access).
 * Papr-proxy-only (no BYOK/OAuth): Gemini first.
 */

import type { AIModel } from "../constants/models";
import type { AuthStatus } from "../hooks/useAuthStatus";

/** Global default before the user picks a model or connects OAuth. */
export const GLOBAL_INITIAL_DEFAULT_MODEL_ID = "gemini-3.8-flash";

/** Curated order when the user has cloud access (OAuth, API key, or Papr+BYOK). */
export const CURATED_MODEL_PRIORITY: readonly string[] = [
  "claude-sonnet-5",
  "gpt-5-6-sol",
  GLOBAL_INITIAL_DEFAULT_MODEL_ID,
];

function hasDirectCloudAuth(status: AuthStatus): boolean {
  return (
    status.openai.oauth ||
    status.openai.apiKey ||
    status.anthropic.oauth ||
    status.anthropic.apiKey ||
    status.google.apiKey
  );
}

/**
 * Model ids to try when no per-chat pick, history, or global default applies.
 */
export function resolveAuthAwareDefaultModelIds(
  status: AuthStatus,
): readonly string[] {
  if (status.paprProxy && !hasDirectCloudAuth(status)) {
    return [
      GLOBAL_INITIAL_DEFAULT_MODEL_ID,
      ...CURATED_MODEL_PRIORITY.filter(
        (id) => id !== GLOBAL_INITIAL_DEFAULT_MODEL_ID,
      ),
    ];
  }

  if (hasDirectCloudAuth(status) || status.paprProxy) {
    return CURATED_MODEL_PRIORITY;
  }

  return ["qwen3.5:9b-q4_k_m", ...CURATED_MODEL_PRIORITY];
}

/**
 * Global new-chat default from current auth. Used after OAuth connect/disconnect
 * so new chats open on something reachable — not a stale disconnected model.
 */
export function resolveGlobalDefaultForAuth(status: AuthStatus): string {
  if (status.anthropic.oauth || status.anthropic.apiKey) {
    return "claude-sonnet-5";
  }
  if (status.openai.oauth || status.openai.apiKey) {
    return "gpt-5-6-sol";
  }
  if (status.google.apiKey || status.paprProxy) {
    return GLOBAL_INITIAL_DEFAULT_MODEL_ID;
  }
  return "qwen3.5:9b-q4_k_m";
}

/** Keep only models the user can actually run. */
export function filterAccessibleModels(
  models: readonly AIModel[],
  isModelAvailable: (model: AIModel) => boolean,
): AIModel[] {
  return models.filter((model) => isModelAvailable(model));
}
