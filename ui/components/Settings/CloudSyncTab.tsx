/**
 * CloudSyncTab — Papr cloud sync, publishing, and status
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { CloudSyncDetails, type SyncItemsResponse } from "./CloudSyncDetails";
import {
  readCloudSyncTabSnapshot,
  writeCloudSyncTabSnapshot,
} from "../../utils/cloudSyncTabCache";
import "./CloudSyncTab.css";

type CloudLinkSyncItem = NonNullable<
  NonNullable<SyncItemsResponse["cloudLinks"]>["items"]
>[number];

interface GitSyncStatus {
  enabled: boolean;
  status?: string;
  lastSyncAt?: string | null;
  lastError?: string | null;
  queueRemaining?: number;
}

interface VaultSyncStatus {
  enabled: boolean;
  status?: string;
  lastSyncAt?: string | null;
  lastError?: string | null;
  keyCount?: number;
}

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

function formatRelativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function statusMeta(s?: string): { color: string; label: string } {
  if (s === "idle") return { color: "#34c759", label: "Synced" };
  if (s === "syncing" || s === "queuing" || s === "cloning" || s === "pulling") {
    const label =
      s === "queuing" ? "Syncing" : s.charAt(0).toUpperCase() + s.slice(1);
    return { color: "#ff9500", label };
  }
  if (s === "error") return { color: "#ff3b30", label: "Error" };
  if (s === "disabled") return { color: "#8e8e93", label: "Off" };
  return { color: "#8e8e93", label: "Waiting" };
}

export function CloudSyncTab() {
  const cached = readCloudSyncTabSnapshot();
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(true);
  const [cloudAutoPublishEnabled, setCloudAutoPublishEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Any in-flight fetch (initial load or background poll). */
  const [loading, setLoading] = useState(false);
  /** User-triggered force refresh (?refresh=1). */
  const [refreshing, setRefreshing] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitSyncStatus | null>(
    (cached?.gitStatus as GitSyncStatus | null) ?? null,
  );
  const [vaultStatus, setVaultStatus] = useState<VaultSyncStatus | null>(
    (cached?.vaultStatus as VaultSyncStatus | null) ?? null,
  );
  const [syncItems, setSyncItems] = useState<SyncItemsResponse | null>(
    cached?.syncItems ?? null,
  );
  const fetchInFlightRef = useRef(false);

  const fetchStatus = useCallback(async (forceRefresh = false) => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    setLoading(true);
    if (forceRefresh) {
      setRefreshing(true);
    }
    try {
      const itemsUrl = forceRefresh
        ? `${GATEWAY}/api/sync/items?refresh=1`
        : `${GATEWAY}/api/sync/items`;
      const [gitRes, vaultRes, itemsRes] = await Promise.all([
        fetch(`${GATEWAY}/api/sync/status`),
        fetch(`${GATEWAY}/api/vault/status`),
        fetch(itemsUrl),
      ]);
      const nextGit = (await gitRes.json()) as GitSyncStatus;
      const nextVault = (await vaultRes.json()) as VaultSyncStatus;
      const nextItems = (await itemsRes.json()) as SyncItemsResponse;
      setGitStatus(nextGit);
      setVaultStatus(nextVault);
      setSyncItems(nextItems);
      writeCloudSyncTabSnapshot({
        gitStatus: nextGit,
        vaultStatus: nextVault,
        syncItems: nextItems,
      });
    } catch {
      /* gateway unavailable */
    } finally {
      fetchInFlightRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const patchCloudLinkItem = useCallback(
    (appId: string, patch: Partial<CloudLinkSyncItem>) => {
      setSyncItems((prev) => {
        if (!prev?.cloudLinks) return prev;
        const next = {
          ...prev,
          cloudLinks: {
            ...prev.cloudLinks,
            items: prev.cloudLinks.items.map((item) =>
              item.appId === appId ? { ...item, ...patch } : item,
            ),
          },
        };
        writeCloudSyncTabSnapshot({
          gitStatus,
          vaultStatus,
          syncItems: next,
        });
        return next;
      });
    },
    [gitStatus, vaultStatus],
  );

  useEffect(() => {
    const load = async () => {
      try {
        const settingsResp = await gateway.send("settings:get");
        const prefs = (
          settingsResp.data as {
            preferences?: {
              cloudSyncEnabled?: boolean;
              cloudAutoPublishEnabled?: boolean;
            };
          }
        )?.preferences;
        if (prefs?.cloudSyncEnabled !== undefined) {
          setCloudSyncEnabled(prefs.cloudSyncEnabled);
        }
        if (prefs?.cloudAutoPublishEnabled !== undefined) {
          setCloudAutoPublishEnabled(prefs.cloudAutoPublishEnabled);
        }
      } catch {
        /* defaults */
      }
      setLoaded(true);
    };
    void load();
  }, []);

  useEffect(() => {
    if (!cloudSyncEnabled || !loaded) return;
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 15_000);
    return () => clearInterval(interval);
  }, [cloudSyncEnabled, loaded, fetchStatus]);

  const savePreference = async (
    patch: Record<string, boolean>,
    apply: (next: boolean) => void,
    next: boolean,
  ) => {
    apply(next);
    setSaving(true);
    try {
      await gateway.send("settings:save-preferences", patch);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <div className="settings-content cloud-sync-tab">
        <div className="settings-section">Loading cloud sync…</div>
      </div>
    );
  }

  const gitDot = statusMeta(gitStatus?.status);
  const vaultDot = statusMeta(vaultStatus?.status);
  const liveLinks = syncItems?.cloudLinks?.summary.live ?? 0;
  const totalLinks = syncItems?.cloudLinks?.summary.total ?? 0;
  const appsHost = syncItems?.cloudLinks?.appsHost ?? "apps.papr.ai";
  const cloudAppsUpdating = loading || refreshing;
  const cloudAppsMeta =
    totalLinks > 0
      ? `${liveLinks} live · ${totalLinks} total${cloudAppsUpdating ? " · updating…" : ""}`
      : cloudAppsUpdating
        ? "Updating…"
        : "No apps published yet";
  const cloudAppsDotColor =
    liveLinks > 0 ? "#34c759" : cloudAppsUpdating ? "#ff9500" : "#8e8e93";

  return (
    <div className="settings-content settings-content--full-width cloud-sync-tab">
      <div className="settings-section">
        <h2 className="settings-section__title">Cloud Sync</h2>
        <p className="cloud-sync-tab__intro">
          Keep your workspace, mini-apps, and linked databases in sync with Papr
          cloud. Published apps open at{" "}
          <code>{appsHost}</code> with the same <code>/api/db/*</code> endpoints
          as desktop. Set Papr login access and an optional external link
          independently for each app.
        </p>

        <div className="cloud-sync-tab__panel">
          <h3 className="cloud-sync-tab__panel-title">Preferences</h3>
          <p className="cloud-sync-tab__panel-desc">
            Changes apply after the next app restart.
          </p>

          <label className="cloud-sync-tab__toggle">
            <input
              type="checkbox"
              checked={cloudSyncEnabled}
              disabled={saving}
              onChange={(e) => {
                void savePreference(
                  { cloudSyncEnabled: e.target.checked },
                  setCloudSyncEnabled,
                  e.target.checked,
                );
              }}
            />
            <div>
              <h4>Enable cloud sync</h4>
              <p>
                Sync workspace files, mini-apps, and jobs to your private Papr
                GitHub repo. Credentials are never stored in git.
              </p>
            </div>
          </label>

          {cloudSyncEnabled ? (
            <label className="cloud-sync-tab__toggle">
              <input
                type="checkbox"
                checked={cloudAutoPublishEnabled}
                disabled={saving}
                onChange={(e) => {
                  void savePreference(
                    { cloudAutoPublishEnabled: e.target.checked },
                    setCloudAutoPublishEnabled,
                    e.target.checked,
                  );
                }}
              />
              <div>
                <h4>Auto-publish mini-apps</h4>
                <p>
                  After sync completes, publish each app to{" "}
                  <code>{appsHost}</code> (private by default). You can override
                  per app below.
                </p>
              </div>
            </label>
          ) : null}
        </div>

        {!cloudSyncEnabled ? (
          <div className="cloud-sync-tab__disabled-note">
            Cloud sync is off. Turn it on to sync your workspace and publish
            mini-apps to the cloud.
          </div>
        ) : (
          <>
            <div className="cloud-sync-tab__overview">
              <div className="cloud-sync-tab__stat">
                <div className="cloud-sync-tab__stat-label">
                  <span
                    className="cloud-sync-tab__stat-dot"
                    style={{ background: gitDot.color }}
                  />
                  Workspace
                </div>
                <div className="cloud-sync-tab__stat-meta">
                  {gitStatus?.status === "queuing" &&
                  gitStatus.queueRemaining != null
                    ? `${gitDot.label} · ${gitStatus.queueRemaining} left`
                    : gitDot.label}
                  {gitStatus?.lastSyncAt
                    ? ` · ${formatRelativeTime(gitStatus.lastSyncAt)}`
                    : ""}
                </div>
              </div>

              <div className="cloud-sync-tab__stat">
                <div className="cloud-sync-tab__stat-label">
                  <span
                    className="cloud-sync-tab__stat-dot"
                    style={{ background: vaultDot.color }}
                  />
                  Credentials
                </div>
                <div className="cloud-sync-tab__stat-meta">
                  {vaultDot.label}
                  {vaultStatus?.keyCount
                    ? ` · ${vaultStatus.keyCount} keys`
                    : ""}
                  {vaultStatus?.lastSyncAt
                    ? ` · ${formatRelativeTime(vaultStatus.lastSyncAt)}`
                    : ""}
                </div>
              </div>

              <div className="cloud-sync-tab__stat">
                <div className="cloud-sync-tab__stat-label">
                  <span
                    className="cloud-sync-tab__stat-dot"
                    style={{ background: cloudAppsDotColor }}
                  />
                  Cloud apps
                </div>
                <div
                  className={
                    cloudAppsUpdating
                      ? "cloud-sync-tab__stat-meta cloud-sync-tab__stat-meta--updating"
                      : "cloud-sync-tab__stat-meta"
                  }
                >
                  {cloudAppsMeta}
                </div>
              </div>
            </div>

            {(gitStatus?.lastError || vaultStatus?.lastError) && (
              <div className="cloud-sync-tab__error">
                {gitStatus?.lastError ? (
                  <div>Workspace: {gitStatus.lastError.slice(0, 160)}</div>
                ) : null}
                {vaultStatus?.lastError ? (
                  <div>Credentials: {vaultStatus.lastError.slice(0, 160)}</div>
                ) : null}
              </div>
            )}

            <CloudSyncDetails
              data={syncItems}
              onRefresh={() => void fetchStatus(true)}
              onItemUpdated={patchCloudLinkItem}
              globalAutoPublishEnabled={cloudAutoPublishEnabled}
              loading={loading}
              refreshing={refreshing}
            />
          </>
        )}
      </div>
    </div>
  );
}
