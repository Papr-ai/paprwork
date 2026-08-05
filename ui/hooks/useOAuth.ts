/**
 * useOAuth - React hook for OAuth authentication
 * Uses push-based events from main process instead of polling.
 * Falls back to paste-token flow after timeout.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { OAuthProviderSource } from "../../src/core/telemetry/oauthProviderSteps";
import { trackEvent } from "../lib/telemetry";
import {
  trackOAuthProviderFailed,
  trackOAuthProviderStep,
} from "../lib/oauthProviderTelemetry";

export interface OAuthStatus {
  connected: boolean;
  accountId?: string;
  expiresAt?: string;
  isExpired?: boolean;
  error?: string;
  timedOut?: boolean;
  /** Set when Claude flow opened a terminal -- UI should show paste field */
  showPasteField?: boolean;
}

const OAUTH_TIMEOUT_MS = 30_000; // 30 seconds before showing fallback

export interface UseOAuthOptions {
  source?: OAuthProviderSource;
}

function trackActivationModelConnected(provider: "openai" | "anthropic"): void {
  const keyName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!localStorage.getItem("papr-activation-model-connected")) {
    localStorage.setItem("papr-activation-model-connected", "true");
    trackEvent("paprwork_activation_model_connected", {
      provider: keyName,
      method: "oauth",
    } as Record<string, unknown>);
  }
}

export function useOAuth(
  provider: "openai" | "anthropic",
  options?: UseOAuthOptions,
) {
  const source = options?.source ?? "settings";
  const [status, setStatus] = useState<OAuthStatus>({ connected: false });
  const [loading, setLoading] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Get the correct OAuth API
  const oauthAPI =
    window.electronAPI.oauth[provider === "openai" ? "openai" : "claude"];

  /**
   * Load OAuth status from main process
   */
  const loadStatus = useCallback(async () => {
    try {
      const result = await oauthAPI.getStatus();
      setStatus(result);
    } catch (error) {
      console.error(`[useOAuth] Failed to load ${provider} status:`, error);
      setStatus({ connected: false, error: (error as Error).message });
    }
  }, [provider]);

  /**
   * Start OAuth login flow
   * Listens for push event from main process instead of polling.
   */
  const startOAuthLogin = useCallback(async () => {
    setLoading(true);
    setStatus({ connected: false }); // Clear previous errors
    trackOAuthProviderStep(provider, "connect_clicked", { source });

    // Clean up any previous listener/timeout
    if (cleanupRef.current) cleanupRef.current();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    try {
      // Set up push listener BEFORE starting OAuth
      const removeListener = window.electronAPI.oauth.onAuthStatus?.(
        (data: { provider: string; status: string; error?: string }) => {
          const matchProvider = provider === "openai" ? "openai" : "anthropic";
          if (data.provider !== matchProvider) return;

          if (timeoutRef.current) clearTimeout(timeoutRef.current);

          if (data.status === "connected") {
            setLoading(false);
            trackActivationModelConnected(provider);
            loadStatus(); // Refresh full status (accountId, expiry, etc.)
          } else if (data.status === "error") {
            setLoading(false);
            trackOAuthProviderFailed(provider, data.error || "Authentication failed", {
              source,
              stage: "callback",
            });
            setStatus({
              connected: false,
              error: data.error || "Authentication failed",
            });
          }
        },
      );

      cleanupRef.current = removeListener || null;

      // Start the OAuth flow
      const result = await oauthAPI.startOAuth();

      if (!result.success) {
        throw new Error(result.error || "OAuth flow failed");
      }

      // If source is "keychain", token was found immediately — no need to wait
      if (result.source === "keychain") {
        setLoading(false);
        trackActivationModelConnected(provider);
        await loadStatus();
        if (cleanupRef.current) cleanupRef.current();
        return;
      }

      // If source is "terminal-opened", the backend opened a terminal with
      // `claude setup-token`. Show the paste field so the user can copy the
      // token from the terminal and paste it here.
      if (result.source === "terminal-opened") {
        setLoading(false);
        setStatus({
          connected: false,
          showPasteField: true,
        });
        if (cleanupRef.current) cleanupRef.current();
        return;
      }

      // Set timeout — if no response in 30s, show fallback
      timeoutRef.current = setTimeout(() => {
        setLoading(false);
        const message =
          provider === "anthropic"
            ? "Sign-in didn't complete. Use Manual Setup below."
            : "Sign-in timed out. Please try again.";
        trackOAuthProviderStep(provider, "connect_timeout", { source, error: message });
        setStatus({
          connected: false,
          timedOut: true,
          error: message,
        });
      }, OAUTH_TIMEOUT_MS);
    } catch (error) {
      console.error(`[useOAuth] Failed to start ${provider} OAuth:`, error);
      const message = error instanceof Error ? error.message : "OAuth flow failed";
      trackOAuthProviderFailed(provider, message, { source, stage: "start" });
      setStatus({ connected: false, error: message });
      setLoading(false);
    }
  }, [provider, loadStatus, source]);

  /**
   * Disconnect OAuth
   */
  const disconnect = useCallback(async () => {
    setLoading(true);
    try {
      const result = await oauthAPI.disconnect();

      if (!result.success) {
        throw new Error(result.error || "Disconnect failed");
      }

      setStatus({ connected: false });
    } catch (error) {
      console.error(`[useOAuth] Failed to disconnect ${provider}:`, error);
      setStatus({
        connected: false,
        error: (error as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, [provider]);

  // Load status on mount
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) cleanupRef.current();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return {
    status,
    loading,
    startOAuthLogin,
    disconnect,
    refresh: loadStatus,
  };
}
