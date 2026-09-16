/**
 * Which credential a chat turn will actually run on.
 *
 * A provider can have a subscription *and* an API key configured at the same
 * time, and Settings lets the user pick between them. That pick is not
 * cosmetic: Electron main withholds the OAuth token from the gateway entirely
 * when "API key" is selected, because the gateway prefers OAuth whenever a
 * token is present and filtering downstream would silently lose to that
 * precedence.
 *
 * So "an OAuth token is stored" and "this turn runs on the subscription" are
 * different questions, and only the second one is worth showing anybody. Code
 * that answered the first described a route the turn did not take — which is
 * how the context panel came to report "Plan · usage unavailable" for a chat
 * billing every token to a Platform API key.
 */

import { requiresOpenAIPlatformApiKey } from "../../src/gateway/utils/modelNormalizer";

export type ProviderAuthPreference = "oauth" | "apiKey";

export interface ProviderCredentials {
  oauth: boolean;
  apiKey: boolean;
  /** Unset means OAuth, matching the historical default. */
  preference: ProviderAuthPreference;
}

/**
 * Mirrors `getProviderAuth` in the gateway plus main's withholding rule.
 *
 * Note the asymmetry: choosing "API key" removes OAuth from consideration even
 * when no key is saved, so the honest answer there is `null` — no direct
 * provider auth — rather than a silent fall back to the subscription. Main
 * withholds unconditionally, so pretending otherwise here would put the panel
 * back in the business of describing the wrong credential.
 */
export function resolveEffectiveAuth(
  credentials: ProviderCredentials,
): ProviderAuthPreference | null {
  if (credentials.preference === "apiKey") {
    return credentials.apiKey ? "apiKey" : null;
  }
  if (credentials.oauth) return "oauth";
  if (credentials.apiKey) return "apiKey";
  return null;
}

/**
 * The same answer for a specific model.
 *
 * Some OpenAI models were retired from ChatGPT OAuth and only run on a
 * Platform key, so the gateway forces that route regardless of preference.
 */
export function resolveEffectiveAuthForModel(
  credentials: ProviderCredentials,
  model: { id: string; provider: string },
): ProviderAuthPreference | null {
  const isOpenAIFamily =
    model.provider === "openai" || model.provider === "openai-codex";
  if (isOpenAIFamily && requiresOpenAIPlatformApiKey(model.id)) {
    return credentials.apiKey ? "apiKey" : null;
  }
  return resolveEffectiveAuth(credentials);
}
