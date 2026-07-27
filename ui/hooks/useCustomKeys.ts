/**
 * useCustomKeys - React hook for managing custom API keys
 * Communicates directly with Electron's secure storage (macOS Keychain)
 */

import { useState, useEffect } from "react";
import type { CustomKey, CustomKeyInput } from "../types/settings";
import { trackEvent } from "../lib/telemetry";

export interface CustomKeysVaultContext {
  organizationId: string | null;
  isLocalVault: boolean;
  workspaceName?: string | null;
  namespaceName?: string | null;
}

// Re-export types for backward compatibility
export type { CustomKey, CustomKeyInput };

export function useCustomKeys() {
  const [keys, setKeys] = useState<CustomKey[]>([]);
  const [vaultContext, setVaultContext] = useState<CustomKeysVaultContext | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load keys on mount and when Papr org workspace changes
  useEffect(() => {
    void loadKeys();

    const onOrgChanged = () => {
      void loadKeys();
    };
    window.addEventListener("papr-organization-changed", onOrgChanged);
    window.addEventListener("papr-namespace-changed", onOrgChanged);
    return () => {
      window.removeEventListener("papr-organization-changed", onOrgChanged);
      window.removeEventListener("papr-namespace-changed", onOrgChanged);
    };
  }, []);

  const loadKeys = async () => {
    setLoading(true);
    setError(null);

    try {
      if (!window.electronAPI?.customKeys) {
        throw new Error(
          "Electron API not available. Make sure the app is running in Electron.",
        );
      }

      const [result, context, profileResult] = await Promise.all([
        window.electronAPI.customKeys.list({ orgOnly: true }),
        window.electronAPI.customKeys.getVaultContext(),
        window.electronAPI.papr?.getProfile?.() ?? Promise.resolve(null),
      ]);

      setKeys(result as CustomKey[]);
      setVaultContext({
        organizationId: context.organizationId,
        isLocalVault: context.isLocalVault,
        workspaceName: profileResult?.success ? profileResult.profile?.workspaceName : null,
        namespaceName: profileResult?.success
          ? profileResult.profile?.activeNamespaceName
          : null,
      });
    } catch (err) {
      console.error("[useCustomKeys] Load error:", err);
      setError(err instanceof Error ? err.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  };

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
    vaultContext,
    loading,
    error,
    loadKeys,
    addKey,
    updateKey,
    deleteKey,
    getKeyValue,
  };
}
