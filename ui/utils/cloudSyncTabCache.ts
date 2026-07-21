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
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...snapshot, savedAt: Date.now() } satisfies CloudSyncTabSnapshot),
    );
  } catch {
    /* quota / private mode */
  }
}

export function readCachedAppCloudSyncStatus(
  appId: string,
): AppCloudSyncStatus | null {
  const snapshot = readCloudSyncTabSnapshot();
  if (!snapshot?.syncItems?.enabled || !snapshot.syncItems.github) {
    return null;
  }
  const git = snapshot.gitStatus as { enabled?: boolean; status?: string } | null;
  if (git?.enabled === false) {
    return null;
  }
  return deriveAppCloudSyncStatus(appId, snapshot.syncItems, git?.status);
}
