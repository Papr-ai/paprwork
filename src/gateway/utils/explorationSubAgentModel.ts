/**
 * Runtime provider/model for the codebase-explorer sub-agent.
 * ChatGPT OAuth (Codex) does not support gpt-5.4-mini — use Luna on OpenAI OAuth, Haiku on Claude OAuth.
 */

import type { Provider } from "../../core/types/agents.js";
import { CODEBASE_EXPLORER_SUB_AGENT_ID } from "../../core/subagents/codebaseExplorer.js";

export { CODEBASE_EXPLORER_SUB_AGENT_ID };

export const EXPLORATION_ANTHROPIC_MODEL = "claude-haiku-4-5";
export const EXPLORATION_OPENAI_OAUTH_MODEL = "gpt-5-6-luna";
export const EXPLORATION_OPENAI_API_KEY_MODEL = "gpt-5.4-mini";
export const EXPLORATION_GOOGLE_MODEL = "gemini-3.8-flash";

export interface ExplorationProviderModel {
  provider: Provider;
  model: string;
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
      return configuredModel.includes("luna") ||
        configuredModel.includes("mini") ||
        configuredModel.includes("nano")
        ? configuredModel
        : EXPLORATION_OPENAI_API_KEY_MODEL;
    case "google":
      return EXPLORATION_GOOGLE_MODEL;
    default:
      return configuredModel;
  }
}
