/**
 * Provider/model for the built-in background jobs (Papr Sleep Cycle, Wiki
 * Writer). Their stored default is Claude Sonnet, which is only right for
 * people who connected Claude. Everyone else started every run on Claude via
 * the Papr proxy, failed in about a second with a full context sent, and only
 * then fell back to the provider they actually connected.
 *
 * Uses the same pick as chat Auto and job auth-refusal retries
 * (findReachableProvider: Claude → OpenAI → Google, strong ladder rung),
 * limited to credentials the user connected directly. Works on desktop and in
 * the cloud gateway (keyResolver reads vault env there). Returns null when
 * nothing is connected directly, so the stored default (Papr proxy) is kept.
 */

import type { Provider } from "../../core/types/agents.js";

export interface SystemJobProviderModel {
  provider: Provider;
  model: string;
}

export async function resolveSystemJobProviderModel(): Promise<SystemJobProviderModel | null> {
  const { findReachableProvider, REACHABLE_PROVIDER_ORDER } = await import(
    "./reachableProvider.js"
  );
  const { autoRefusedProviders } = await import("./autoProviderHealth.js");
  const next = await findReachableProvider(
    autoRefusedProviders(),
    REACHABLE_PROVIDER_ORDER,
    { directOnly: true },
  );
  return next ? { provider: next.provider, model: next.model } : null;
}
