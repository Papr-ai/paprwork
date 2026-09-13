/**
 * useAuthStatus - Combined OAuth + API key status for model availability
 * Used by model picker to gray out models user doesn't have access to
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useOAuth } from "./useOAuth";
import { useCustomKeys } from "./useCustomKeys";
import { isPaprProxyOnlyModel } from "../../src/core/constants/paprCloudFeatures";
import { resolvePaprCloudFeatureAccess } from "../../src/core/utils/paprCloudFeatureAccess";
import { usePaprCloudFeatureStore } from "../stores/paprCloudFeatureStore";
import { resolveGlobalDefaultForAuth } from "../utils/authAwareModelDefaults";
import { writeNewChatDefaultModel } from "../utils/chatModelMemory";
import { gateway } from "../src/lib/gateway";

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

  const [paprLoggedIn, setPaprLoggedIn] = useState(false);
  const paprCloudContext = usePaprCloudFeatureStore((state) => state.context);

  const [status, setStatus] = useState<AuthStatus>({
    openai: { oauth: false, apiKey: false },
    anthropic: { oauth: false, apiKey: false },
    google: { apiKey: false },
    paprProxy: false,
  });

  const refreshPaprLogin = useCallback(async () => {
    try {
      const result = await window.electronAPI?.papr?.checkLoginStatus?.();
      setPaprLoggedIn(Boolean(result?.success && result?.isLoggedIn));
    } catch {
      setPaprLoggedIn(false);
    }
  }, []);

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
      // Key may not appear in the Settings keys list immediately after login;
      // Papr session alone means proxy routing is available.
      paprProxy: hasKey("PAPR_API_KEY") || paprLoggedIn,
    });
  }, [
    keys,
    paprLoggedIn,
    openaiOAuth.status.connected,
    openaiOAuth.status.isExpired,
    anthropicOAuth.status.connected,
    anthropicOAuth.status.isExpired,
  ]);

  useEffect(() => {
    void refreshPaprLogin();
    const onPaprAuthChange = () => {
      void refreshPaprLogin();
    };
    window.addEventListener("papr-login-success", onPaprAuthChange);
    window.addEventListener("papr-logout-success", onPaprAuthChange);
    return () => {
      window.removeEventListener("papr-login-success", onPaprAuthChange);
      window.removeEventListener("papr-logout-success", onPaprAuthChange);
    };
  }, [refreshPaprLogin]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const prevOAuthRef = useRef<{ anthropic: boolean; openai: boolean } | null>(
    null,
  );

  // Reseed global new-chat default when OAuth connects or disconnects.
  useEffect(() => {
    const current = {
      anthropic: status.anthropic.oauth,
      openai: status.openai.oauth,
    };
    const previous = prevOAuthRef.current;
    prevOAuthRef.current = current;
    if (previous === null) {
      return;
    }

    const oauthChanged =
      previous.anthropic !== current.anthropic ||
      previous.openai !== current.openai;
    if (!oauthChanged) {
      return;
    }

    const modelId = resolveGlobalDefaultForAuth(status);
    writeNewChatDefaultModel(modelId);
    gateway
      .send("settings:save-ui-preferences", { lastModelId: modelId })
      .catch(() => {});
  }, [status.anthropic.oauth, status.openai.oauth, status]);

  const isModelAvailable = useCallback(
    (model: { id: string; provider: string; requiresApiKey: string }) => {
      // Ollama runs locally, always available (no API key required)
      if (model.provider === "ollama") {
        return true;
      }

      if (isPaprProxyOnlyModel(model.provider)) {
        if (!status.paprProxy) {
          return false;
        }
        if (paprCloudContext) {
          return resolvePaprCloudFeatureAccess("papr_ai_proxy", paprCloudContext)
            .allowed;
        }
        return true;
      }

      // Direct provider auth (OAuth / BYOK) — no Papr Cloud subscription required
      if (model.provider === "google" && status.google.apiKey) {
        return true;
      }
      if (model.provider === "openai-codex") {
        return status.openai.oauth;
      }
      if (model.provider === "openai") {
        return status.openai.oauth || status.openai.apiKey;
      }
      if (model.provider === "anthropic") {
        return status.anthropic.oauth || status.anthropic.apiKey;
      }

      // Papr proxy routes models without direct auth — requires active subscription
      if (status.paprProxy) {
        if (paprCloudContext) {
          return resolvePaprCloudFeatureAccess("papr_ai_proxy", paprCloudContext)
            .allowed;
        }
        return true;
      }

      // gpt-5.3-codex retired on ChatGPT OAuth — requires Platform API key
      if (model.id === "gpt-5.3-codex") {
        return status.openai.apiKey;
      }

      if (model.provider === "google") {
        return status.google.apiKey;
      }
      return false;
    },
    [status, paprCloudContext],
  );

  return {
    status,
    isModelAvailable,
    refresh: async () => {
      await openaiOAuth.refresh();
      await anthropicOAuth.refresh();
      await loadKeys();
      await refreshPaprLogin();
      refresh();
    },
  };
}
