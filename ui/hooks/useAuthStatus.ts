/**
 * useAuthStatus - Combined OAuth + API key status for model availability
 * Used by model picker to gray out models user doesn't have access to
 */

import { useState, useEffect, useCallback } from "react";
import { useOAuth } from "./useOAuth";
import { useCustomKeys } from "./useCustomKeys";

export interface AuthStatus {
  openai: { oauth: boolean; apiKey: boolean };
  anthropic: { oauth: boolean; apiKey: boolean };
  google: { apiKey: boolean };
  paprProxy: boolean; // PAPR_API_KEY enables all providers via proxy
}

/** Model has access if OAuth connected OR API key present (OAuth preferred) */
function hasAccess(
  provider: "openai" | "anthropic" | "google",
  status: AuthStatus,
): boolean {
  switch (provider) {
    case "openai":
      return status.openai.oauth || status.openai.apiKey;
    case "anthropic":
      return status.anthropic.oauth || status.anthropic.apiKey;
    case "google":
      return status.google.apiKey;
    default:
      return false;
  }
}

export function useAuthStatus() {
  const openaiOAuth = useOAuth("openai");
  const anthropicOAuth = useOAuth("anthropic");
  const { keys, loadKeys } = useCustomKeys();

  const [status, setStatus] = useState<AuthStatus>({
    openai: { oauth: false, apiKey: false },
    anthropic: { oauth: false, apiKey: false },
    google: { apiKey: false },
    paprProxy: false,
  });

  const refresh = useCallback(() => {
    const hasKey = (name: string) => keys.some((k) => k.name === name);

    setStatus({
      openai: {
        oauth: openaiOAuth.status.connected && !openaiOAuth.status.isExpired,
        apiKey: hasKey("OPENAI_API_KEY"),
      },
      anthropic: {
        oauth:
          anthropicOAuth.status.connected && !anthropicOAuth.status.isExpired,
        apiKey: hasKey("ANTHROPIC_API_KEY"),
      },
      google: {
        apiKey:
          hasKey("GOOGLE_API_KEY") || hasKey("GOOGLE_GENERATIVE_AI_API_KEY"),
      },
      paprProxy: hasKey("PAPR_API_KEY"), // Papr proxy enables all providers
    });
  }, [
    keys,
    openaiOAuth.status.connected,
    openaiOAuth.status.isExpired,
    anthropicOAuth.status.connected,
    anthropicOAuth.status.isExpired,
  ]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isModelAvailable = useCallback(
    (model: { id: string; provider: string; requiresApiKey: string }) => {
      // Ollama runs locally, always available (no API key required)
      if (model.provider === "ollama") {
        return true;
      }
      
      // Papr proxy enables ALL cloud providers (OpenAI, Anthropic, Google)
      if (status.paprProxy) {
        return true;
      }

      // GLM requires Papr login (proxied through memory server)
      if (model.provider === "zai") {
        return status.paprProxy;
      }

      // Groq models require Papr login (proxied through memory server)
      if (model.provider === "groq") {
        return status.paprProxy;
      }

      // gpt-5.3-codex retired on ChatGPT OAuth — requires Platform API key
      if (model.id === "gpt-5.3-codex") {
        return status.openai.apiKey;
      }
      
      // Otherwise check provider-specific auth
      if (model.provider === "openai-codex") {
        return status.openai.oauth;
      }
      if (model.provider === "openai") {
        return status.openai.oauth || status.openai.apiKey;
      }
      if (model.provider === "anthropic") {
        return status.anthropic.oauth || status.anthropic.apiKey;
      }
      if (model.provider === "google") {
        return status.google.apiKey;
      }
      return false;
    },
    [status],
  );

  return {
    status,
    isModelAvailable,
    refresh: async () => {
      await openaiOAuth.refresh();
      await anthropicOAuth.refresh();
      await loadKeys();
      refresh();
    },
  };
}
