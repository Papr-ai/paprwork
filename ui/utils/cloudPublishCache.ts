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
      JSON.stringify({ byAppId, savedAt: Date.now() } satisfies CloudPublishSnapshot),
    );
  } catch {
    /* quota / private mode */
  }
}

export function readCachedCloudPublishState(
  appId: string,
): CloudPublishState | null {
  const snapshot = readSnapshot();
  return snapshot?.byAppId[appId] ?? null;
}

export function writeCachedCloudPublishState(
  appId: string,
  state: CloudPublishState | null,
): void {
  const snapshot = readSnapshot();
  const byAppId = { ...(snapshot?.byAppId ?? {}) };
  if (state) {
    byAppId[appId] = state;
  } else {
    delete byAppId[appId];
  }
  writeSnapshot(byAppId);
}
