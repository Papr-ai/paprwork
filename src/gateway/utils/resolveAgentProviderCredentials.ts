/**
 * Shared provider credential resolution for chat, jobs, and sub-agents.
 * Mirrors websocket/agent.ts: direct OAuth/API key first, then Papr AI proxy.
 */

import type { Provider } from "../../core/types/index.js";
import {
  getApiKeys,
  getPaprApiKey,
  getProviderAuthForModel,
  PAPR_PROXY_SIGN_IN_MESSAGE,
  resolvePaprProxyAuth,
} from "./keyResolver.js";
import { requiresOpenAIPlatformApiKey } from "./modelNormalizer.js";

export type ResolvedAgentCredentials = {
  apiKey: string;
  authType: "oauth" | "apiKey";
  usePaprProxy?: boolean;
};

function providerApiKeyName(provider: Provider): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

/**
 * Resolve credentials for a provider/model pair. Returns null when no auth
 * (including Papr proxy) is available.
 */
export async function resolveAgentProviderCredentials(
  provider: Provider,
  model: string,
): Promise<ResolvedAgentCredentials | null> {
  if (provider === "ollama") {
    return { apiKey: "", authType: "apiKey" };
  }

  if (provider === "cursor") {
    const paprApiKey = await getPaprApiKey();
    if (!paprApiKey) {
      return null;
    }
    return { apiKey: paprApiKey, authType: "apiKey" };
  }

  if (
    provider === "openai" ||
    provider === "openai-codex" ||
    provider === "anthropic"
  ) {
    const authProvider = provider === "openai-codex" ? "openai" : provider;
    const auth = await getProviderAuthForModel(authProvider, {
      modelId: model,
      modelProvider: provider,
    });

    if (auth) {
      return {
        apiKey: auth.type === "oauth" ? auth.token : auth.key,
        authType: auth.type,
      };
    }

    const paprProxy = await resolvePaprProxyAuth();
    if (paprProxy) {
      console.log(
        `[resolveAgentProviderCredentials] No direct ${provider} auth — using Papr AI proxy`,
      );
      return {
        apiKey: paprProxy.apiKey,
        authType: "apiKey",
        usePaprProxy: paprProxy.usePaprProxy,
      };
    }

    return null;
  }

  const keyName = providerApiKeyName(provider);
  const keys = await getApiKeys([keyName]);
  const directKey = keys[keyName];
  if (directKey) {
    return { apiKey: directKey, authType: "apiKey" };
  }

  const paprProxy = await resolvePaprProxyAuth();
  if (paprProxy) {
    console.log(
      `[resolveAgentProviderCredentials] No ${keyName} — using Papr AI proxy`,
    );
    return {
      apiKey: paprProxy.apiKey,
      authType: "apiKey",
      usePaprProxy: paprProxy.usePaprProxy,
    };
  }

  return null;
}

export function agentProviderAuthErrorMessage(
  provider: Provider,
  model: string,
): string {
  if (provider === "cursor") {
    return "Composer requires Papr login. Sign in with Papr to use Cursor Composer.";
  }

  if (
    provider === "openai" ||
    provider === "openai-codex" ||
    provider === "anthropic"
  ) {
    if (requiresOpenAIPlatformApiKey(model)) {
      return `${model} requires an OpenAI API key. It is no longer available via ChatGPT OAuth.`;
    }
  }

  return PAPR_PROXY_SIGN_IN_MESSAGE;
}
