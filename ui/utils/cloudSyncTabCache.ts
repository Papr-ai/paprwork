/**
 * Client-side cache for cloud sync payloads (stale-while-revalidate).
 * Persists in localStorage so publish bar can show last status on app launch.
 */

import type { SyncItemsResponse } from "../components/Settings/CloudSyncDetails";
import {
  deriveAppCloudSyncStatus,
  type AppCloudSyncStatus,
} from "./appCloudSyncStatus";

const STORAGE_KEY = "paprwork.cloudSyncSnapshot.v2";
const LEGACY_SESSION_KEY = "paprwork.cloudSyncTab.v1";

export interface CloudSyncTabSnapshot {
  gitStatus: Record<string, unknown> | null;
  vaultStatus: Record<string, unknown> | null;
  syncItems: SyncItemsResponse | null;
  /** Last fetched /api/sync/items payload per mini-app (publish bar). */
  syncItemsByAppId?: Record<string, SyncItemsResponse>;
  savedAt: number;
}

function readLegacySessionSnapshot(): CloudSyncTabSnapshot | null {
  try {
    const raw = sessionStorage.getItem(LEGACY_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CloudSyncTabSnapshot;
  } catch {
    return null;
  }
}

export function readCloudSyncTabSnapshot(): CloudSyncTabSnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as CloudSyncTabSnapshot;
    }
    const legacy = readLegacySessionSnapshot();
    if (legacy) {
      writeCloudSyncTabSnapshot({
        gitStatus: legacy.gitStatus,
        vaultStatus: legacy.vaultStatus,
        syncItems: legacy.syncItems,
      });
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCloudSyncTabSnapshot(
  snapshot: Omit<CloudSyncTabSnapshot, "savedAt">,
): void {
  try {
    const existing = readCloudSyncTabSnapshot();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...snapshot,
        syncItemsByAppId:
          snapshot.syncItemsByAppId ?? existing?.syncItemsByAppId,
        savedAt: Date.now(),
      } satisfies CloudSyncTabSnapshot),
    );
  } catch {
    /* quota / private mode */
  }
}

export function readCachedSyncItemsForApp(
  appId: string,
): SyncItemsResponse | null {
  const snapshot = readCloudSyncTabSnapshot();
  const byApp = snapshot?.syncItemsByAppId?.[appId];
  if (byApp) {
    return byApp;
  }
  const legacy = snapshot?.syncItems;
  if (!legacy) {
    return null;
  }
  if (legacy.appContext?.appId === appId) {
    return legacy;
  }
  const hasAppRow = legacy.github?.apps?.some((app) => app.id === appId);
  return hasAppRow ? legacy : null;
}

export function writeCachedSyncItemsForApp(
  appId: string,
  items: SyncItemsResponse,
): void {
  const existing = readCloudSyncTabSnapshot();
  writeCloudSyncTabSnapshot({
    gitStatus: existing?.gitStatus ?? null,
    vaultStatus: existing?.vaultStatus ?? null,
    syncItems: items,
    syncItemsByAppId: {
      ...(existing?.syncItemsByAppId ?? {}),
      [appId]: items,
    },
  });
}

export function readCachedAppCloudSyncStatus(
  appId: string,
): AppCloudSyncStatus | null {
  const items = readCachedSyncItemsForApp(appId);
  if (!items?.enabled || !items.github) {
    return null;
  }
  const git = readCloudSyncTabSnapshot()?.gitStatus as {
    enabled?: boolean;
    status?: string;
  } | null;
  if (git?.enabled === false) {
    return null;
  }
  return deriveAppCloudSyncStatus(appId, items, git?.status);
}
