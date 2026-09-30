/**
 * Job / sub-agent session auth with the same fallback order as main chat:
 * direct auth (incl. Papr proxy) → explicit profile fallback → smart fallback → default.
 */

import type { Provider } from "../../core/types/index.js";
import {
  agentProviderAuthErrorMessage,
  resolveAgentProviderCredentials,
  type ResolvedAgentCredentials,
} from "./resolveAgentProviderCredentials.js";

export type JobSessionAuth = {
  provider: Provider;
  model: string;
  apiKey: string;
  authType: "oauth" | "apiKey";
  usePaprProxy?: boolean;
};

export async function resolveJobSessionAuth(params: {
  provider: Provider;
  model: string;
  requestedModel?: string;
  fallbackProvider?: Provider;
  fallbackModel?: string;
}): Promise<JobSessionAuth> {
  const originalProvider = params.provider;
  const requestedModel = params.requestedModel ?? params.model;

  let provider = params.provider;
  let model = params.model;

  let creds = await resolveAgentProviderCredentials(provider, model);
  if (creds) {
    return { provider, model, ...creds };
  }

  if (params.fallbackProvider && params.fallbackModel) {
    const fbCreds = await resolveAgentProviderCredentials(
      params.fallbackProvider,
      params.fallbackModel,
    );
    if (fbCreds) {
      console.log(
        `[AgentService] Explicit fallback: ${originalProvider}/${requestedModel} → ${params.fallbackProvider}/${params.fallbackModel}`,
      );
      return {
        provider: params.fallbackProvider,
        model: params.fallbackModel,
        ...fbCreds,
      };
    }
  }

  const { getBestFallbackModel } = await import("./smartFallback.js");
  const { getAvailableProviders, getDefaultProviderAndModel } =
    await import("./defaultProvider.js");

  const available = await getAvailableProviders();
  const smart = await getBestFallbackModel(
    originalProvider,
    requestedModel,
    available,
  );

  if (smart) {
    provider = smart.provider;
    model = smart.model;
    console.log(
      `[AgentService] Smart fallback: ${originalProvider}/${requestedModel} → ${provider}/${model} (capability-matched)`,
    );
  } else {
    const defaults = await getDefaultProviderAndModel();
    provider = defaults.provider;
    model = defaults.model;
    console.log(
      `[AgentService] Falling back from ${originalProvider} to ${provider}/${model}`,
    );
  }

  creds = await resolveAgentProviderCredentials(provider, model);
  if (creds) {
    return { provider, model, ...creds };
  }

  throw new Error(
    agentProviderAuthErrorMessage(originalProvider, requestedModel),
  );
}

/**
 * After OAuth rate limit, retry with Platform API key or Papr proxy (same as chat).
 */
export async function resolveOAuthRateLimitRetryCredentials(
  provider: Provider,
  model: string,
): Promise<ResolvedAgentCredentials | null> {
  const authProvider = provider === "openai-codex" ? "openai" : provider;
  if (authProvider === "openai" || authProvider === "anthropic") {
    const keyName =
      authProvider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const { getApiKeys } = await import("./keyResolver.js");
    const keys = await getApiKeys([keyName]);
    if (keys[keyName]) {
      return { apiKey: keys[keyName], authType: "apiKey" };
    }
  }

  return resolveAgentProviderCredentials(provider, model);
}
