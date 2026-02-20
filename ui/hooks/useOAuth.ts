/**
 * useOAuth - React hook for OAuth authentication
 * Manages OAuth login flow for OpenAI and Claude
 */

import { useState, useEffect } from "react";

export interface OAuthStatus {
  connected: boolean;
  accountId?: string;
  expiresAt?: string;
  isExpired?: boolean;
  error?: string;
}

export function useOAuth(provider: "openai" | "anthropic") {
  const [status, setStatus] = useState<OAuthStatus>({ connected: false });
  const [loading, setLoading] = useState(false);

  // Get the correct OAuth API
  const oauthAPI = window.electronAPI.oauth[provider === "openai" ? "openai" : "claude"];

  /**
   * Load OAuth status
   */
  const loadStatus = async () => {
    try {
      const result = await oauthAPI.getStatus();
      setStatus(result);
    } catch (error) {
      console.error(`[useOAuth] Failed to load ${provider} status:`, error);
      setStatus({ connected: false, error: (error as Error).message });
    }
  };

  /**
   * Start OAuth login flow
   */
  const startOAuthLogin = async () => {
    setLoading(true);
    try {
      const result = await oauthAPI.startOAuth();
      
      if (!result.success) {
        throw new Error(result.error || "OAuth flow failed");
      }

      // Poll for status updates (check every 2 seconds for 5 minutes)
      const maxAttempts = 150; // 5 minutes
      let attempts = 0;

      const pollInterval = setInterval(async () => {
        attempts++;
        await loadStatus();

        // Check if connected
        const currentStatus = await oauthAPI.getStatus();
        if (currentStatus.connected) {
          clearInterval(pollInterval);
          setLoading(false);
          setStatus(currentStatus);
        }

        // Timeout after max attempts
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          setLoading(false);
        }
      }, 2000);

    } catch (error) {
      console.error(`[useOAuth] Failed to start ${provider} OAuth:`, error);
      setStatus({ connected: false, error: (error as Error).message });
      setLoading(false);
    }
  };

  /**
   * Disconnect OAuth
   */
  const disconnect = async () => {
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
        error: (error as Error).message 
      });
    } finally {
      setLoading(false);
    }
  };

  // Load status on mount
  useEffect(() => {
    loadStatus();
  }, [provider]);

  return {
    status,
    loading,
    startOAuthLogin,
    disconnect,
    refresh: loadStatus,
  };
}
