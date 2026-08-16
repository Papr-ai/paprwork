/**
 * Poll gateway sync status for a single mini-app (publish bar chip).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SyncItemsResponse } from "../components/Settings/CloudSyncDetails";
import {
  deriveAppCloudSyncStatus,
  type AppCloudSyncStatus,
} from "../utils/appCloudSyncStatus";
import {
  readCachedAppCloudSyncStatus,
  readCloudSyncTabSnapshot,
  writeCloudSyncTabSnapshot,
} from "../utils/cloudSyncTabCache";

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

const GATEWAY_READY_MAX_MS = 45_000;
const GATEWAY_READY_POLL_MS = 1_000;

interface GitSyncStatus {
  enabled: boolean;
  status?: string;
  reason?: string;
  cloudPublishing?: boolean;
}

const STATUS_CACHE_MS = 1_500;
let gitStatusInFlight: Promise<GitSyncStatus> | null = null;
let cachedGitStatus: { value: GitSyncStatus; at: number } | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readInitialSyncItems(): SyncItemsResponse | null {
  const snapshot = readCloudSyncTabSnapshot();
  const items = snapshot?.syncItems ?? null;
  const git = snapshot?.gitStatus as GitSyncStatus | null;
  if (!items?.enabled || !items.github) {
    return null;
  }
  if (git?.enabled === false) {
    return null;
  }
  return items;
}

function mergeSyncItemsWithGitStatus(
  items: SyncItemsResponse,
  git: GitSyncStatus,
): SyncItemsResponse {
  if (items.enabled || !git.enabled) {
    return items;
  }
  return {
    ...items,
    enabled: true,
    reason: undefined,
  };
}

function shouldPersistSyncSnapshot(
  items: SyncItemsResponse,
  git: GitSyncStatus,
): boolean {
  return items.enabled || git.enabled;
}

async function fetchGitSyncStatus(): Promise<GitSyncStatus> {
  if (cachedGitStatus && Date.now() - cachedGitStatus.at < STATUS_CACHE_MS) {
    return cachedGitStatus.value;
  }
  if (gitStatusInFlight) return gitStatusInFlight;

  gitStatusInFlight = (async () => {
    const res = await fetch(`${GATEWAY}/api/sync/status`);
    if (!res.ok) {
      throw new Error(`Sync status failed (${res.status})`);
    }
    const value = (await res.json()) as GitSyncStatus;
    cachedGitStatus = { value, at: Date.now() };
    return value;
  })().finally(() => {
    gitStatusInFlight = null;
  });

  return gitStatusInFlight;
}

/** Gateway returns enabled:false while CloudSyncService is still starting. */
async function waitForGitSyncReady(): Promise<GitSyncStatus> {
  const deadline = Date.now() + GATEWAY_READY_MAX_MS;
  let last: GitSyncStatus = { enabled: false };

  while (Date.now() < deadline) {
    last = await fetchGitSyncStatus();
    if (last.enabled) {
      return last;
    }
    if (last.reason && last.reason !== "Cloud sync not initialized") {
      return last;
    }
    await sleep(GATEWAY_READY_POLL_MS);
  }

  return last;
}

export function useAppCloudSyncStatus(
  appId: string,
  options?: { enabled?: boolean },
): {
  status: AppCloudSyncStatus | null;
  gitSyncEnabled: boolean | null;
  globalAutoUploadEnabled: boolean;
  loading: boolean;
  refreshing: boolean;
  pushing: boolean;
  pulling: boolean;
  applyingUpdates: boolean;
  error: string | null;
  refresh: (force?: boolean) => Promise<void>;
  pushNow: () => Promise<void>;
  pullUpdates: () => Promise<void>;
  applyRemoteUpdates: () => Promise<void>;
} {
  const active = options?.enabled !== false;
  const initialItems = readInitialSyncItems();
  const initialStatus = initialItems
    ? deriveAppCloudSyncStatus(
        appId,
        initialItems,
        (readCloudSyncTabSnapshot()?.gitStatus as GitSyncStatus | null)?.status,
      )
    : readCachedAppCloudSyncStatus(appId);

  const [syncItems, setSyncItems] = useState<SyncItemsResponse | null>(
    initialItems,
  );
  const globalAutoUploadEnabled =
    syncItems?.appContext?.globalAutoUploadEnabled ?? true;
  const [gitSyncEnabled, setGitSyncEnabled] = useState<boolean | null>(() => {
    const git = readCloudSyncTabSnapshot()?.gitStatus as GitSyncStatus | null;
    return git?.enabled ?? null;
  });
  const [gitGlobalStatus, setGitGlobalStatus] = useState<string | undefined>(
    () => {
      const git = readCloudSyncTabSnapshot()?.gitStatus as GitSyncStatus | null;
      return git?.status;
    },
  );
  const [cloudPublishing, setCloudPublishing] = useState(false);
  const [loading, setLoading] = useState(initialStatus === null);
  const [refreshing, setRefreshing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [applyingUpdates, setApplyingUpdates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedOnceRef = useRef(initialStatus !== null);
  const refreshInFlightRef = useRef(false);

  const status = useMemo(() => {
    if (syncItems) {
      return deriveAppCloudSyncStatus(appId, syncItems, gitGlobalStatus, {
        isUploading: pushing,
        refreshing,
      });
    }
    return null;
  }, [appId, syncItems, gitGlobalStatus, pushing, refreshing]);

  const refresh = useCallback(
    async (force = false) => {
      if (!active || refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      const isBackgroundRefresh = hasLoadedOnceRef.current && !force;
      try {
        setError(null);
        if (!hasLoadedOnceRef.current) {
          setLoading(true);
        } else if (isBackgroundRefresh) {
          setRefreshing(true);
        }

        const git = await waitForGitSyncReady();
        setGitSyncEnabled(git.enabled);
        setGitGlobalStatus(git.status);
        setCloudPublishing(git.cloudPublishing === true);

        if (!git.enabled) {
          setSyncItems({
            enabled: false,
            reason: git.reason ?? "Cloud sync not initialized",
            github: null,
            turso: null,
          });
          hasLoadedOnceRef.current = true;
          return;
        }

        const itemsUrl = force
          ? `${GATEWAY}/api/sync/items?refresh=1&appId=${encodeURIComponent(appId)}`
          : `${GATEWAY}/api/sync/items?appId=${encodeURIComponent(appId)}`;
        const itemsRes = await fetch(itemsUrl);
        if (!itemsRes.ok) {
          throw new Error(`Sync items failed (${itemsRes.status})`);
        }

        const rawItems = (await itemsRes.json()) as SyncItemsResponse;
        const items = mergeSyncItemsWithGitStatus(rawItems, git);
        setSyncItems(items);
        hasLoadedOnceRef.current = true;

        if (shouldPersistSyncSnapshot(items, git)) {
          const existing = readCloudSyncTabSnapshot();
          writeCloudSyncTabSnapshot({
            gitStatus: git,
            vaultStatus: existing?.vaultStatus ?? null,
            syncItems: items,
          });
        }
      } catch (err) {
        setError((err as Error).message.slice(0, 120));
      } finally {
        refreshInFlightRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [active, appId],
  );

  const pushNow = useCallback(async () => {
    if (status?.gitRemoteRequiresReview) {
      setError("Merge remote changes first, then upload.");
      return;
    }
    setPushing(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/api/sync/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId }),
      });
      if (res.status === 202) {
        const deadline = Date.now() + 15 * 60_000;
        while (Date.now() < deadline) {
          await sleep(2_000);
          const itemsRes = await fetch(
            `${GATEWAY}/api/sync/items?refresh=1&appId=${encodeURIComponent(appId)}`,
          );
          if (!itemsRes.ok) {
            continue;
          }
          const items = (await itemsRes.json()) as SyncItemsResponse;
          if (items.uploadError?.message && !items.uploadError.retryPending) {
            throw new Error(items.uploadError.message);
          }
          if (items.upload?.status === "failed" && !items.upload.retryPending) {
            throw new Error(items.upload.detail ?? items.upload.label);
          }
          if (items.upload?.status === "idle") {
            break;
          }
        }
        await refresh(true);
        return;
      }
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Upload failed (${res.status})`);
      }
      await refresh(true);
    } catch (err) {
      setError((err as Error).message.slice(0, 120));
    } finally {
      setPushing(false);
    }
  }, [refresh, appId, status?.gitRemoteRequiresReview]);

  const pullUpdates = useCallback(async () => {
    if (status?.gitRemoteRequiresReview) {
      setError("Use Merge remote changes — Get updates cannot merge diverged git history.");
      return;
    }
    setPulling(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/api/sync/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Get updates failed (${res.status})`);
      }
      await refresh(true);
    } catch (err) {
      setError((err as Error).message.slice(0, 120));
    } finally {
      setPulling(false);
    }
  }, [refresh, status?.gitRemoteRequiresReview]);

  const applyRemoteUpdates = useCallback(async () => {
    setApplyingUpdates(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/api/sync/apply-updates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Merge failed (${res.status})`);
      }
      await refresh(true);
    } catch (err) {
      const message = (err as Error).message.slice(0, 160);
      setError(message);
    } finally {
      setApplyingUpdates(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (!active) {
      setLoading(false);
      return;
    }

    setPushing(false);
    setPulling(false);
    setApplyingUpdates(false);
    setError(null);

    void refresh(false);
  }, [active, appId, refresh]);

  useEffect(() => {
    if (!active) return;
    const intervalMs =
      pushing ||
      pulling ||
      applyingUpdates ||
      status?.overall === "uploading" ||
      status?.publishStatus === "republishing" ||
      status?.globallySyncing
        ? 3_000
        : 25_000;
    const timer = setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, refresh, pushing, pulling, applyingUpdates, status?.overall, status?.publishStatus, status?.globallySyncing]);

  return {
    status,
    gitSyncEnabled,
    globalAutoUploadEnabled,
    loading,
    refreshing,
    pushing,
    pulling,
    applyingUpdates,
    error,
    refresh,
    pushNow,
    pullUpdates,
    applyRemoteUpdates,
  };
}
