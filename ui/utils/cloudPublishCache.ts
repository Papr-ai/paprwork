/**
 * Client-side cache for per-app cloud publish state (stale-while-revalidate).
 * Lets the publish bar show the last known live URL and status on tab remount.
 */

import type { CloudPublishState } from "./cloudPublishApi";

const STORAGE_KEY = "paprwork.cloudPublishSnapshot.v1";

interface CloudPublishSnapshot {
  byAppId: Record<string, CloudPublishState>;
  savedAt: number;
}

function readSnapshot(): CloudPublishSnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CloudPublishSnapshot;
  } catch {
    return null;
  }
}

function writeSnapshot(byAppId: Record<string, CloudPublishState>): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        byAppId,
        savedAt: Date.now(),
      } satisfies CloudPublishSnapshot),
    );
  } catch {
    /* quota / private mode */
  }
}

export function readCachedCloudPublishStates(): Record<
  string,
  CloudPublishState
> {
  return readSnapshot()?.byAppId ?? {};
}

export function readCachedCloudPublishState(
  appId: string,
): CloudPublishState | null {
  return readCachedCloudPublishStates()[appId] ?? null;
}

export function writeCachedCloudPublishState(
  appId: string,
  state: CloudPublishState | null,
): void {
  if (state && state.appId && state.appId !== appId) {
    return;
  }
  const snapshot = readSnapshot();
  const byAppId = { ...(snapshot?.byAppId ?? {}) };
  if (state) {
    byAppId[appId] = { ...state, appId };
  } else {
    delete byAppId[appId];
  }
  writeSnapshot(byAppId);
}

const DEFAULT_PUBLISH_REVALIDATION_LIMIT = 24;

/**
 * Which app ids to background-fetch for Live/Draft badges.
 * After workspace switch the snapshot is empty; without a bootstrap pass the
 * Apps grid never refetches and every app looks unpublished until opened.
 */
export function selectAppIdsForPublishRevalidation(
  allAppIds: string[],
  cached: Record<string, CloudPublishState>,
  limit = DEFAULT_PUBLISH_REVALIDATION_LIMIT,
): string[] {
  const known = allAppIds.filter((id) => cached[id]);
  if (known.length > 0) {
    return known
      .sort(
        (a, b) =>
          Number(Boolean(cached[b]?.shareUrl)) -
          Number(Boolean(cached[a]?.shareUrl)),
      )
      .slice(0, limit);
  }
  return allAppIds.slice(0, limit);
}

/** Clear all cached publish state (e.g. after org/namespace switch). */
export function clearCloudPublishCache(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* quota / private mode */
  }
}
