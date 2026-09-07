import type { Provider } from "../../src/core/types/agents";
import { CHAT_MODELS } from "../constants/models";

/**
 * Whether a stream error means the provider rejected our credentials, as
 * opposed to a rate limit, an overload, or a bad tool call.
 *
 * The gateway usually rewrites a 401 into "Invalid API key. Please check your
 * API key in Settings." before it reaches us, but the raw Anthropic body
 * ("OAuth access token is invalid.") reaches the renderer on some paths, so
 * both shapes are matched here.
 */
export function isProviderAuthRejection(rawError: string): boolean {
  return (
    rawError.includes("Invalid API key") ||
    rawError.includes("invalid x-api-key") ||
    rawError.includes("authentication_error") ||
    rawError.includes("OAuth access token") ||
    rawError.includes("(401)")
  );
}

/**
 * Which provider a model belongs to. Used to attribute a rejection to the
 * account the user would go fix, since the error itself does not say.
 */
export function providerForModelId(
  modelId: string | undefined,
): Provider | undefined {
  if (!modelId) return undefined;
  return CHAT_MODELS.find((model) => model.id === modelId)?.provider;
}
