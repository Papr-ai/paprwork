/**
 * Client-side cache for cloud sync payloads (stale-while-revalidate).
 * Persists in localStorage so publish bar can show last status on app launch.
 */

import type { SyncItemsResponse } from "../components/Settings/CloudSyncDetails";
import {
  deriveAppCloudSyncStatus,
  type AppCloudSyncStatus,
} from "./appCloudSyncStatus";
import { boundByRecency, touchNewest } from "./boundedRecencyMap";

const STORAGE_KEY = "paprwork.cloudSyncSnapshot.v2";
const LEGACY_SESSION_KEY = "paprwork.cloudSyncTab.v1";

/**
 * How many per-app sync payloads to keep.
 *
 * This cache exists so the publish bar can show a last-known status before the
 * live fetch lands, which only matters for apps the user is about to open — at
 * most the mounted warm set (7) plus the one being opened. It was previously
 * unbounded, and each payload runs to ~160KB, so a workspace with 27 apps grew
 * it to 4.3MB. Keys from builds that derived them differently were still in
 * there too, since nothing ever removed anything.
 */
const MAX_CACHED_APPS = 12;

/**
 * Parsed snapshot, held so repeated reads do not re-parse the payload.
 *
 * Callers read this on render paths, and `JSON.parse` of the stored blob was
 * measured at 233 MB/s of synchronous main-thread work. How often a caller
 * reads is the caller's business; making a read cheap is this module's.
 */
let memo: CloudSyncTabSnapshot | null = null;
let memoLoaded = false;

if (typeof window !== "undefined") {
  // Another window on this origin wrote: our copy is stale. Mini-apps are on
  // their own origins now, so this only ever fires for a second Paprwork window.
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      memo = null;
      memoLoaded = false;
    }
  });
}

export interface CloudSyncTabSnapshot {
  gitStatus: Record<string, unknown> | null;
  vaultStatus: Record<string, unknown> | null;
  syncItems: SyncItemsResponse | null;
  /** Last fetched /api/sync/items payload per mini-app (publish bar). */
  syncItemsByAppId?: Record<string, SyncItemsResponse>;
  /** When each app's syncItems payload was last written (ms since epoch). */
  syncItemsFetchedAtByAppId?: Record<string, number>;
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
  if (memoLoaded) {
    return memo;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      memo = JSON.parse(raw) as CloudSyncTabSnapshot;
      memoLoaded = true;
      return memo;
    }
    const legacy = readLegacySessionSnapshot();
    if (legacy) {
      // Sets the memo as a side effect, so return that rather than `legacy` —
      // the written copy carries `savedAt` and the merged per-app map.
      writeCloudSyncTabSnapshot({
        gitStatus: legacy.gitStatus,
        vaultStatus: legacy.vaultStatus,
        syncItems: legacy.syncItems,
      });
      return memo;
    }
    memo = null;
    memoLoaded = true;
    return null;
  } catch {
    return null;
  }
}

export function writeCloudSyncTabSnapshot(
  snapshot: Omit<CloudSyncTabSnapshot, "savedAt">,
): void {
  const existing = readCloudSyncTabSnapshot();
  const next: CloudSyncTabSnapshot = {
    ...snapshot,
    syncItemsByAppId: snapshot.syncItemsByAppId ?? existing?.syncItemsByAppId,
    syncItemsFetchedAtByAppId:
      snapshot.syncItemsFetchedAtByAppId ?? existing?.syncItemsFetchedAtByAppId,
    savedAt: Date.now(),
  };
  // Update the memo even if the write below fails: it reflects what this tab
  // believes, and a quota failure does not make the previous value current.
  memo = next;
  memoLoaded = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
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

export function readCachedSyncItemsFetchedAt(appId: string): number | null {
  const snapshot = readCloudSyncTabSnapshot();
  const at = snapshot?.syncItemsFetchedAtByAppId?.[appId];
  if (typeof at === "number" && Number.isFinite(at)) {
    return at;
  }
  if (readCachedSyncItemsForApp(appId) && typeof snapshot?.savedAt === "number") {
    return snapshot.savedAt;
  }
  return null;
}

/** Drop cached /api/sync/items payload so UI refetches after a background upload. */
export function invalidateCachedSyncItemsForApp(appId: string): void {
  const existing = readCloudSyncTabSnapshot();
  if (!existing) {
    return;
  }
  const hadPerApp = Boolean(existing.syncItemsByAppId?.[appId]);
  const legacyMatches =
    existing.syncItems?.appContext?.appId === appId ||
    existing.syncItems?.github?.apps?.some((app) => app.id === appId);
  if (!hadPerApp && !legacyMatches) {
    return;
  }
  const nextByApp = { ...(existing.syncItemsByAppId ?? {}) };
  delete nextByApp[appId];
  const nextFetchedAt = { ...(existing.syncItemsFetchedAtByAppId ?? {}) };
  delete nextFetchedAt[appId];
  writeCloudSyncTabSnapshot({
    gitStatus: existing.gitStatus,
    vaultStatus: existing.vaultStatus,
    syncItems: legacyMatches ? null : existing.syncItems,
    syncItemsByAppId: nextByApp,
    syncItemsFetchedAtByAppId: nextFetchedAt,
  });
}

export function writeCachedSyncItemsForApp(
  appId: string,
  items: SyncItemsResponse,
): void {
  const existing = readCloudSyncTabSnapshot();
  const fetchedAt = Date.now();
  const nextByApp = boundByRecency(
    touchNewest(existing?.syncItemsByAppId ?? {}, appId, items),
    MAX_CACHED_APPS,
  );
  const nextFetchedAt = touchNewest(
    existing?.syncItemsFetchedAtByAppId ?? {},
    appId,
    fetchedAt,
  );
  writeCloudSyncTabSnapshot({
    gitStatus: existing?.gitStatus ?? null,
    vaultStatus: existing?.vaultStatus ?? null,
    syncItems: items,
    syncItemsByAppId: nextByApp,
    // Held to the same key set as the payloads, not merely the same bound. A
    // timestamp whose payload has been evicted would make
    // `readCachedSyncItemsFetchedAt` answer for a cache miss, and the map
    // would otherwise be the one thing here still growing without limit.
    syncItemsFetchedAtByAppId: Object.fromEntries(
      Object.entries(nextFetchedAt).filter(([id]) => id in nextByApp),
    ),
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
