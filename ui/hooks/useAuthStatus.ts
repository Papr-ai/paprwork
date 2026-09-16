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
import type { ProviderAuthPreference } from "../utils/effectiveProviderAuth";

/** Fired by Settings when the OAuth/API-key toggle flips. */
export const PROVIDER_AUTH_CHANGED_EVENT = "papr-provider-auth-changed";

export interface AuthStatus {
  /**
   * `preference` is which credential the user picked when both exist. It is
   * load-bearing, not cosmetic: main withholds the OAuth token from the
   * gateway when it is "apiKey", so reading `oauth` alone describes a route
   * the turn may never take. Use `resolveEffectiveAuth` rather than these
   * flags directly when the question is "what is this turn running on".
   */
  openai: { oauth: boolean; apiKey: boolean; preference: ProviderAuthPreference };
  anthropic: {
    oauth: boolean;
    apiKey: boolean;
    preference: ProviderAuthPreference;
  };
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
  const [preferences, setPreferences] = useState<{
    openai: ProviderAuthPreference;
    anthropic: ProviderAuthPreference;
  }>({ openai: "oauth", anthropic: "oauth" });

  const [status, setStatus] = useState<AuthStatus>({
    openai: { oauth: false, apiKey: false, preference: "oauth" },
    anthropic: { oauth: false, apiKey: false, preference: "oauth" },
    google: { apiKey: false },
    paprProxy: false,
  });

  /**
   * Read from main rather than mirrored in the renderer: main is the only
   * process that can say which credential it will hand the gateway, and a
   * second copy here is a second thing to get out of sync.
   */
  const refreshPreferences = useCallback(async () => {
    try {
      const api = window.electronAPI?.providerAuth;
      if (!api) return;
      const [openai, anthropic] = await Promise.all([
        api.getPreference("openai"),
        api.getPreference("anthropic"),
      ]);
      setPreferences({
        openai: openai?.preference === "apiKey" ? "apiKey" : "oauth",
        anthropic: anthropic?.preference === "apiKey" ? "apiKey" : "oauth",
      });
    } catch {
      // Leaving the default alone means we describe the historical behaviour
      // (OAuth preferred), which is what an unreadable preference means.
    }
  }, []);

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
        preference: preferences.openai,
      },
      anthropic: {
        oauth:
          anthropicOAuth.status.connected && !anthropicOAuth.status.isExpired,
        apiKey: hasKey("ANTHROPIC_API_KEY"),
        preference: preferences.anthropic,
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
    preferences.openai,
    preferences.anthropic,
  ]);

  // The toggle lives in Settings, which can be open beside a chat, so the
  // panel has to hear about the switch rather than wait for a remount.
  useEffect(() => {
    void refreshPreferences();
    const onChange = () => {
      void refreshPreferences();
    };
    window.addEventListener(PROVIDER_AUTH_CHANGED_EVENT, onChange);
    return () =>
      window.removeEventListener(PROVIDER_AUTH_CHANGED_EVENT, onChange);
  }, [refreshPreferences]);

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
      await refreshPreferences();
      refresh();
    },
  };
}
