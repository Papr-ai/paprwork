/**
 * useOAuth - React hook for OAuth authentication
 * Uses push-based events from main process instead of polling.
 * Falls back to paste-token flow after timeout.
 */

import { useState, useEffect, useRef, useCallback } from "react";

export interface OAuthStatus {
  connected: boolean;
  accountId?: string;
  expiresAt?: string;
  isExpired?: boolean;
  error?: string;
  timedOut?: boolean;
}

const OAUTH_TIMEOUT_MS = 30_000; // 30 seconds before showing fallback

export function useOAuth(provider: "openai" | "anthropic") {
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
            loadStatus(); // Refresh full status (accountId, expiry, etc.)
          } else if (data.status === "error") {
            setLoading(false);
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
        await loadStatus();
        if (cleanupRef.current) cleanupRef.current();
        return;
      }

      // Set timeout — if no response in 30s, show fallback
      timeoutRef.current = setTimeout(() => {
        setLoading(false);
        setStatus({
          connected: false,
          timedOut: true,
          error:
            provider === "anthropic"
              ? "Sign-in didn't complete. Try pasting your token instead."
              : "Sign-in timed out. Please try again.",
        });
      }, OAUTH_TIMEOUT_MS);
    } catch (error) {
      console.error(`[useOAuth] Failed to start ${provider} OAuth:`, error);
      setStatus({ connected: false, error: (error as Error).message });
      setLoading(false);
    }
  }, [provider, loadStatus]);

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
