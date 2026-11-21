/**
 * Provider/model for the built-in background jobs (Papr Sleep Cycle, Wiki
 * Writer). Their stored default is Claude Sonnet, which is only right for
 * people who connected Claude. Everyone else started every run on Claude via
 * the Papr proxy, failed in about a second with a full context sent, and only
 * then fell back to the provider they actually connected.
 *
 * Pick the strong model of a provider the user connected directly, in the same
 * order as the main chat default (Claude, then OpenAI, then Google). Returns
 * null when nothing is connected directly, so the caller keeps the stored
 * default (Papr proxy users).
 */

import type { Provider } from "../../core/types/agents.js";
import { DEFAULT_AUTO_LADDERS } from "../../core/agents/autoLadders.js";

export interface SystemJobProviderModel {
  provider: Provider;
  model: string;
}

function strongModel(provider: Provider): string | null {
  return DEFAULT_AUTO_LADDERS[provider]?.models.strong ?? null;
}

export async function resolveSystemJobProviderModel(): Promise<SystemJobProviderModel | null> {
  const { getProviderAuth, getApiKeys } = await import("./keyResolver.js");

  for (const provider of ["anthropic", "openai"] as const) {
    try {
      if (await getProviderAuth(provider)) {
        const model = strongModel(provider);
        if (model) return { provider, model };
      }
    } catch {
      // try the next provider
    }
  }

  try {
    const keys = await getApiKeys(["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"]);
    if (keys.GOOGLE_GENERATIVE_AI_API_KEY || keys.GOOGLE_API_KEY) {
      const model = strongModel("google");
      if (model) return { provider: "google", model };
    }
  } catch {
    // fall through
  }

  return null;
}
