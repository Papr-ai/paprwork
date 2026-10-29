/**
 * Sign-in-aware provider/model for built-in helper agents (codebase-explorer,
 * research-specialist, implementation-specialist).
 *
 * A stored profile model is only right for one kind of sign-in: gpt-5.4-mini
 * runs on an OpenAI Platform key but not on ChatGPT sign-in, so a profile
 * pinned to it sent the ChatGPT token to the Platform API ("Invalid API key").
 * Pick the cheap model the user's actual credential can run instead:
 * Claude → Haiku, OpenAI (ChatGPT sign-in or Platform key) → GPT-5.6 Luna,
 * Google → Gemini Flash.
 */

import type { Provider } from "../../core/types/agents.js";
import { CODEBASE_EXPLORER_SUB_AGENT_ID } from "../../core/subagents/codebaseExplorer.js";

export { CODEBASE_EXPLORER_SUB_AGENT_ID };

export const EXPLORATION_ANTHROPIC_MODEL = "claude-haiku-4-5";
export const EXPLORATION_OPENAI_OAUTH_MODEL = "gpt-5-6-luna";
/** Luna runs on both ChatGPT sign-in and a Platform key, so one model covers both. */
export const EXPLORATION_OPENAI_API_KEY_MODEL = "gpt-5-6-luna";
export const EXPLORATION_GOOGLE_MODEL = "gemini-3.8-flash";

export interface ExplorationProviderModel {
  provider: Provider;
  model: string;
}

/** Built-in helpers whose stored model is replaced by the sign-in-aware pick. */
export const SIGN_IN_AWARE_SUB_AGENT_IDS: ReadonlySet<string> = new Set([
  CODEBASE_EXPLORER_SUB_AGENT_ID,
  "research-specialist",
  "implementation-specialist",
]);

export function usesSignInAwareModel(subAgentId: string | undefined): boolean {
  return !!subAgentId && SIGN_IN_AWARE_SUB_AGENT_IDS.has(subAgentId.trim());
}

/** Same pick as the explorer; exported under a name that says what it is for. */
export async function resolveHelperAgentProviderModel(): Promise<ExplorationProviderModel> {
  return resolveCodebaseExplorerProviderModel();
}

export async function resolveCodebaseExplorerProviderModel(): Promise<ExplorationProviderModel> {
  const { getProviderAuth, getApiKeys } = await import("./keyResolver.js");

  const anthropicAuth = await getProviderAuth("anthropic");
  if (anthropicAuth) {
    return {
      provider: "anthropic",
      model: EXPLORATION_ANTHROPIC_MODEL,
    };
  }

  const openaiAuth = await getProviderAuth("openai");
  if (openaiAuth) {
    return {
      provider: "openai",
      model:
        openaiAuth.type === "oauth"
          ? EXPLORATION_OPENAI_OAUTH_MODEL
          : EXPLORATION_OPENAI_API_KEY_MODEL,
    };
  }

  try {
    const keys = await getApiKeys([
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GOOGLE_API_KEY",
    ]);
    const googleKey =
      keys.GOOGLE_GENERATIVE_AI_API_KEY || keys.GOOGLE_API_KEY;
    if (googleKey) {
      return { provider: "google", model: EXPLORATION_GOOGLE_MODEL };
    }
  } catch {
    // fall through
  }

  const { getDefaultProviderAndModel } = await import("./defaultProvider.js");
  const defaults = await getDefaultProviderAndModel();
  return {
    provider: defaults.provider,
    model: cheapModelForProvider(defaults.provider, defaults.model),
  };
}

function cheapModelForProvider(provider: Provider, configuredModel: string): string {
  switch (provider) {
    case "anthropic":
      return EXPLORATION_ANTHROPIC_MODEL;
    case "openai":
    case "openai-codex":
      return configuredModel.includes("luna")
        ? configuredModel
        : EXPLORATION_OPENAI_OAUTH_MODEL;
    case "google":
      return EXPLORATION_GOOGLE_MODEL;
    default:
      return configuredModel;
  }
}
