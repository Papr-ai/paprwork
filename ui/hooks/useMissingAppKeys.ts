/**
 * Keys an app runs on "Mine" that aren't in the owner's keychain.
 * Drives the bar's missing-key chip and the warning in Share → API keys.
 *
 * Re-checks when the window regains focus (the usual way back from Settings),
 * when the keychain store changes, when `reloadToken` bumps, and when the
 * gateway broadcasts app:requirements-changed (catalog edited on disk).
 */

import { useEffect, useState } from "react";
import type { RequiredKeySpec } from "../../src/core/types/bundles";
import { fetchAppRequirements } from "../utils/cloudAppRequirementsApi";
import { missingOwnerKeys } from "../utils/shareSheetModel";
import { useCustomKeysStore } from "../stores/customKeysStore";
import { useTabStore } from "../stores/tabStore";

async function ownedKeyNames(): Promise<string[]> {
  const api = window.electronAPI?.customKeys;
  if (!api) return [];
  // Merged list (global + shared + org) — the same set a job run resolves from.
  const keys = await api.list();
  return keys.map((key) => key.name);
}

/**
 * Bumps when the gateway says this app's key catalog changed on disk
 * (requirements.json, backend manifest, or a linked job's requiredKeys).
 */
export function useRequirementsChangedTick(appId: string): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onBroadcast = (event: Event) => {
      const d = (event as CustomEvent).detail as
        | { type?: string; data?: { appId?: string } }
        | undefined;
      if (d?.type !== "app:requirements-changed") return;
      if (d.data?.appId && d.data.appId !== appId) return;
      setTick((n) => n + 1);
    };
    window.addEventListener("gateway-broadcast", onBroadcast);
    return () => window.removeEventListener("gateway-broadcast", onBroadcast);
  }, [appId]);
  return tick;
}

export function useMissingAppKeys(
  appId: string,
  enabled: boolean,
  reloadToken = 0,
): RequiredKeySpec[] {
  const [missing, setMissing] = useState<RequiredKeySpec[]>([]);
  const [focusTick, setFocusTick] = useState(0);
  const keychainLoadedAt = useCustomKeysStore((state) => state.loadedAt);

  const catalogTick = useRequirementsChangedTick(appId);

  useEffect(() => {
    const bump = () => setFocusTick((n) => n + 1);
    window.addEventListener("focus", bump);
    return () => window.removeEventListener("focus", bump);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setMissing([]);
      return;
    }
    let cancelled = false;
    Promise.all([fetchAppRequirements(appId), ownedKeyNames()])
      .then(([discovery, names]) => {
        if (!cancelled)
          setMissing(missingOwnerKeys(discovery.requirements, names));
      })
      .catch(() => {
        // A failed check must not invent a problem; keep the last known state.
      });
    return () => {
      cancelled = true;
    };
  }, [appId, enabled, reloadToken, focusTick, keychainLoadedAt, catalogTick]);

  return missing;
}

/** Open Settings → API keys (same route the Sidebar uses for Profile). */
export function openKeySettings(): void {
  const { createTab, switchToTab } = useTabStore.getState();
  const tabId = createTab("settings", "settings", "Settings");
  switchToTab(tabId);
  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("papr:open-settings", { detail: { tab: "keys" } }),
    );
  }, 60);
}
