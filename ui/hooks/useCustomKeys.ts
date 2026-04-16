/**
 * useCustomKeys - React hook for managing custom API keys
 * Communicates directly with Electron's secure storage (macOS Keychain)
 */

import { useState, useEffect } from "react";
import type { CustomKey, CustomKeyInput } from "../types/settings";
import { trackEvent } from "../lib/telemetry";

// Re-export types for backward compatibility
export type { CustomKey, CustomKeyInput };

export function useCustomKeys() {
  const [keys, setKeys] = useState<CustomKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load keys on mount
  useEffect(() => {
    loadKeys();
  }, []);

  /**
   * Load all custom keys
   */
  const loadKeys = async () => {
    setLoading(true);
    setError(null);

    try {
      // Check if electronAPI is available
      if (!window.electronAPI || !window.electronAPI.customKeys) {
        throw new Error(
          "Electron API not available. Make sure the app is running in Electron.",
        );
      }

      const result = await window.electronAPI.customKeys.list();
      setKeys(result as CustomKey[]);
    } catch (err) {
      console.error("[useCustomKeys] Load error:", err);
      setError(err instanceof Error ? err.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Add new custom key
   */
  const addKey = async (input: CustomKeyInput): Promise<boolean> => {
    try {
      await window.electronAPI.customKeys.add(input);
      await loadKeys();
      trackEvent("paprwork_provider_configured", {
        provider_key_name: input.name,
        method: "api_key",
      } as Record<string, unknown>);
      return true;
    } catch (err) {
      console.error("[useCustomKeys] Add error:", err);
      setError(err instanceof Error ? err.message : "Failed to add key");
      return false;
    }
  };

  /**
   * Update existing custom key
   */
  const updateKey = async (
    keyId: string,
    updates: Partial<CustomKeyInput>,
  ): Promise<boolean> => {
    try {
      await window.electronAPI.customKeys.update(keyId, updates);
      await loadKeys();
      return true;
    } catch (err) {
      console.error("[useCustomKeys] Update error:", err);
      setError(err instanceof Error ? err.message : "Failed to update key");
      return false;
    }
  };

  /**
   * Delete custom key
   */
  const deleteKey = async (keyId: string): Promise<boolean> => {
    try {
      await window.electronAPI.customKeys.delete(keyId);
      await loadKeys();
      return true;
    } catch (err) {
      console.error("[useCustomKeys] Delete error:", err);
      setError(err instanceof Error ? err.message : "Failed to delete key");
      return false;
    }
  };

  /**
   * Get key value by ID (for editing - shows masked, then reveal with eye)
   */
  const getKeyValue = async (keyId: string): Promise<string | null> => {
    try {
      if (!window.electronAPI?.customKeys?.get) return null;
      return await window.electronAPI.customKeys.get(keyId);
    } catch (err) {
      console.error("[useCustomKeys] Get value error:", err);
      return null;
    }
  };

  return {
    keys,
    loading,
    error,
    loadKeys,
    addKey,
    updateKey,
    deleteKey,
    getKeyValue,
  };
}
