/**
 * Find a cloud provider this user can actually call, for turns whose chosen
 * provider has no credentials (Auto routing, main-agent triggers).
 *
 * Order mirrors the Auto ladders: Anthropic → OpenAI → Google. Each candidate is
 * verified with the same resolver chat uses, so a provider is only returned when
 * a real credential (OAuth, API key, or Papr proxy) exists for it.
 */

import type { Provider } from "../../core/types/index.js";
import { DEFAULT_AUTO_LADDERS } from "../../core/agents/autoLadders.js";
import {
  resolveAgentProviderCredentials,
  type ResolvedAgentCredentials,
} from "./resolveAgentProviderCredentials.js";

export const REACHABLE_PROVIDER_ORDER: readonly Provider[] = [
  "anthropic",
  "openai",
  "google",
];

export type ReachableProvider = {
  provider: Provider;
  model: string;
  creds: ResolvedAgentCredentials;
};

/** `openai-codex` shares OpenAI auth, so excluding one excludes both. */
function sameFamily(a: Provider, b: Provider): boolean {
  const norm = (p: Provider) => (p === "openai-codex" ? "openai" : p);
  return norm(a) === norm(b);
}

export async function findReachableProvider(
  exclude: readonly Provider[] = [],
  order: readonly Provider[] = REACHABLE_PROVIDER_ORDER,
): Promise<ReachableProvider | null> {
  for (const provider of order) {
    if (exclude.some((e) => sameFamily(e, provider))) continue;
    const model = DEFAULT_AUTO_LADDERS[provider]?.models.strong;
    if (!model) continue;
    try {
      const creds = await resolveAgentProviderCredentials(provider, model);
      if (creds) return { provider, model, creds };
    } catch {
      // Treat a resolver failure as "not reachable" and try the next provider.
    }
  }
  return null;
}
