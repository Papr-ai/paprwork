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

  const provider = params.provider;
  const model = params.model;

  const creds = await resolveAgentProviderCredentials(provider, model);
  if (creds) {
    return keepOAuthOnSupportedModel({ provider, model, ...creds });
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
      return keepOAuthOnSupportedModel({
        provider: params.fallbackProvider,
        model: params.fallbackModel,
        ...fbCreds,
      });
    }
  }

  // Capability-matched pick first, then every other provider the user can reach
  // (Anthropic → OpenAI → Google). One unusable candidate must not end the
  // search — e.g. a Claude-pinned profile on a Google-only account.
  const tried = new Set<string>([`${provider}/${model}`]);
  if (params.fallbackProvider && params.fallbackModel) {
    tried.add(`${params.fallbackProvider}/${params.fallbackModel}`);
  }
  const candidates: Array<{ provider: Provider; model: string; why: string }> =
    [];

  try {
    const { getBestFallbackModel } = await import("./smartFallback.js");
    const { getAvailableProviders } = await import("./defaultProvider.js");
    const available = await getAvailableProviders();
    const smart = await getBestFallbackModel(
      originalProvider,
      requestedModel,
      available,
    );
    if (smart) candidates.push({ ...smart, why: "capability-matched" });
  } catch (error) {
    console.warn("[AgentService] Smart fallback lookup failed:", error);
  }

  const { REACHABLE_PROVIDER_ORDER } = await import("./reachableProvider.js");
  const { DEFAULT_AUTO_LADDERS } = await import(
    "../../core/agents/autoLadders.js"
  );
  for (const p of REACHABLE_PROVIDER_ORDER) {
    const m = DEFAULT_AUTO_LADDERS[p]?.models.strong;
    if (m) candidates.push({ provider: p, model: m, why: "reachable provider" });
  }

  const { getDefaultProviderAndModel } = await import("./defaultProvider.js");
  const defaults = await getDefaultProviderAndModel();
  candidates.push({ ...defaults, why: "default" });

  for (const cand of candidates) {
    const key = `${cand.provider}/${cand.model}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const candCreds = await resolveAgentProviderCredentials(
      cand.provider,
      cand.model,
    );
    if (candCreds) {
      console.log(
        `[AgentService] Fallback (${cand.why}): ${originalProvider}/${requestedModel} → ${key}`,
      );
      return keepOAuthOnSupportedModel({
        provider: cand.provider,
        model: cand.model,
        ...candCreds,
      });
    }
  }

  throw new Error(
    agentProviderAuthErrorMessage(originalProvider, requestedModel),
  );
}

/** Cheap OpenAI model that runs on ChatGPT sign-in. */
export const CHATGPT_SIGN_IN_FALLBACK_MODEL = "gpt-5-6-luna";

/**
 * A ChatGPT sign-in token only works on the models ChatGPT serves. For any other
 * OpenAI model (gpt-5.4-mini, gpt-5.3-codex…) the session would go down the
 * Platform API route with that token and fail with "Invalid API key". Use a
 * real Platform key when there is one; otherwise run on Luna, which ChatGPT does
 * serve.
 */
export async function keepOAuthOnSupportedModel(
  auth: JobSessionAuth,
): Promise<JobSessionAuth> {
  const isOpenAI = auth.provider === "openai" || auth.provider === "openai-codex";
  if (!isOpenAI || auth.authType !== "oauth" || auth.usePaprProxy) return auth;

  const { isOpenAICodexModel } = await import("./modelNormalizer.js");
  if (isOpenAICodexModel(auth.model)) return auth;

  const { getApiKeys } = await import("./keyResolver.js");
  const keys = await getApiKeys(["OPENAI_API_KEY"]);
  if (keys.OPENAI_API_KEY) {
    console.log(
      `[AgentService] ${auth.model} is not served on ChatGPT sign-in — using the OpenAI API key`,
    );
    return { ...auth, apiKey: keys.OPENAI_API_KEY, authType: "apiKey" };
  }

  console.log(
    `[AgentService] ${auth.model} is not served on ChatGPT sign-in and there is no OpenAI API key — running on ${CHATGPT_SIGN_IN_FALLBACK_MODEL}`,
  );
  return { ...auth, provider: "openai", model: CHATGPT_SIGN_IN_FALLBACK_MODEL };
}

/**
 * Next provider for an agent job whose provider refused its credential before
 * producing anything. Skips every provider that has refused this auth epoch.
 */
export async function resolveAuthRefusalRetry(
  refusedProvider: Provider,
): Promise<JobSessionAuth | null> {
  const { markAutoProviderRefused, autoRefusedProviders } = await import(
    "./autoProviderHealth.js"
  );
  markAutoProviderRefused(refusedProvider);
  const { findReachableProvider } = await import("./reachableProvider.js");
  const next = await findReachableProvider(autoRefusedProviders());
  if (!next) return null;
  return keepOAuthOnSupportedModel({
    provider: next.provider,
    model: next.model,
    ...next.creds,
  });
}

/**
 * After OAuth rate limit, retry with Platform API key or Papr proxy (same as chat).
 */
export async function resolveOAuthRateLimitRetryCredentials(
  provider: Provider,
  _model: string,
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

  // No Platform key: only the Papr proxy is a real alternative. Never return the
  // same OAuth token — callers would send it down an API-key route.
  const { resolvePaprProxyAuth } = await import("./keyResolver.js");
  const proxy = await resolvePaprProxyAuth();
  return proxy
    ? { apiKey: proxy.apiKey, authType: "apiKey", usePaprProxy: proxy.usePaprProxy }
    : null;
}
