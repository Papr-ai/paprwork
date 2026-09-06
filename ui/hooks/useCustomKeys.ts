/**
 * useCustomKeys - React hook for managing custom API keys
 * Communicates directly with Electron's secure storage (macOS Keychain)
 */

import { useEffect } from "react";
import type { CustomKey, CustomKeyInput } from "../types/settings";
import { trackEvent } from "../lib/telemetry";
import { useCustomKeysStore } from "../stores/customKeysStore";

export interface CustomKeysVaultContext {
  organizationId: string | null;
  isLocalVault: boolean;
  workspaceName?: string | null;
  namespaceName?: string | null;
}

export type { CustomKey, CustomKeyInput };

export function useCustomKeys() {
  const keys = useCustomKeysStore((state) => state.keys);
  const vaultContext = useCustomKeysStore((state) => state.vaultContext);
  const loading = useCustomKeysStore((state) => state.loading);
  const error = useCustomKeysStore((state) => state.error);
  const loadKeys = useCustomKeysStore((state) => state.loadKeys);
  const addKey = useCustomKeysStore((state) => state.addKey);
  const updateKey = useCustomKeysStore((state) => state.updateKey);
  const deleteKey = useCustomKeysStore((state) => state.deleteKey);
  const getKeyValue = useCustomKeysStore((state) => state.getKeyValue);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const addKeyWithTelemetry = async (
    input: CustomKeyInput,
  ): Promise<boolean> => {
    const ok = await addKey(input);
    if (ok) {
      trackEvent("paprwork_provider_configured", {
        provider_key_name: input.name,
        method: "api_key",
      } as Record<string, unknown>);
    }
    return ok;
  };

  return {
    keys,
    vaultContext,
    loading,
    error,
    loadKeys: (force?: boolean) => loadKeys(force ? { force: true } : undefined),
    addKey: addKeyWithTelemetry,
    updateKey,
    deleteKey,
    getKeyValue,
  };
}
