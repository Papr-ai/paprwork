/**
 * Shared custom-keys cache — one keychain read serves Settings, Chat, OAuth, etc.
 */

import { create } from "zustand";
import type { CustomKey, CustomKeyInput } from "../types/settings";
import type { CustomKeysVaultContext } from "../hooks/useCustomKeys";

const CACHE_TTL_MS = 30_000;

interface CustomKeysStoreState {
  keys: CustomKey[];
  vaultContext: CustomKeysVaultContext | null;
  loading: boolean;
  error: string | null;
  loadedAt: number;
  loadKeys: (options?: { force?: boolean }) => Promise<void>;
  invalidate: () => void;
  addKey: (input: CustomKeyInput) => Promise<boolean>;
  updateKey: (keyId: string, updates: Partial<CustomKeyInput>) => Promise<boolean>;
  deleteKey: (keyId: string) => Promise<boolean>;
  getKeyValue: (keyId: string) => Promise<string | null>;
}

let loadInFlight: Promise<void> | null = null;

function ensureListeners(): void {
  if (typeof window === "undefined" || ensureListeners.installed) {
    return;
  }
  ensureListeners.installed = true;
  const invalidate = () => useCustomKeysStore.getState().invalidate();
  window.addEventListener("papr-organization-changed", invalidate);
  window.addEventListener("papr-namespace-changed", invalidate);
}
ensureListeners.installed = false;

export const useCustomKeysStore = create<CustomKeysStoreState>((set, get) => ({
  keys: [],
  vaultContext: null,
  loading: false,
  error: null,
  loadedAt: 0,

  invalidate: () => {
    set({ loadedAt: 0 });
  },

  loadKeys: async (options) => {
    ensureListeners();
    const force = options?.force ?? false;
    const { loadedAt, keys } = get();
    if (
      !force &&
      keys.length > 0 &&
      loadedAt > 0 &&
      Date.now() - loadedAt < CACHE_TTL_MS
    ) {
      return;
    }
    if (loadInFlight && !force) {
      await loadInFlight;
      return;
    }

    set({ loading: true, error: null });
    loadInFlight = (async () => {
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

        set({
          keys: result as CustomKey[],
          vaultContext: {
            organizationId: context.organizationId,
            isLocalVault: context.isLocalVault,
            workspaceName: profileResult?.success
              ? profileResult.profile?.workspaceName
              : null,
            namespaceName: profileResult?.success
              ? profileResult.profile?.activeNamespaceName
              : null,
          },
          loadedAt: Date.now(),
          error: null,
        });
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : "Failed to load keys",
        });
      } finally {
        set({ loading: false });
        loadInFlight = null;
      }
    })();

    await loadInFlight;
  },

  addKey: async (input) => {
    try {
      await window.electronAPI.customKeys.add(input);
      get().invalidate();
      await get().loadKeys({ force: true });
      return true;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to add key",
      });
      return false;
    }
  },

  updateKey: async (keyId, updates) => {
    try {
      await window.electronAPI.customKeys.update(keyId, updates);
      get().invalidate();
      await get().loadKeys({ force: true });
      return true;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to update key",
      });
      return false;
    }
  },

  deleteKey: async (keyId) => {
    try {
      await window.electronAPI.customKeys.delete(keyId);
      get().invalidate();
      await get().loadKeys({ force: true });
      return true;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to delete key",
      });
      return false;
    }
  },

  getKeyValue: async (keyId) => {
    try {
      return await window.electronAPI.customKeys.getValue(keyId);
    } catch {
      return null;
    }
  },
}));
