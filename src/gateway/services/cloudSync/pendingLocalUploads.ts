/**
 * Detect app/job folders with local edits not yet uploaded to the Papr cloud git repo.
 * Used to defer git pull and Turso cloud→local reconcile so stale remote state cannot
 * overwrite in-progress agent work (SYNC_CONTRACT §6).
 */

import * as fs from "fs";
import * as path from "path";
import type { CloudSyncService } from "../CloudSyncService.js";
import { listAppLinkedSyncKeys } from "../tursoLinkedSources.js";
import { listDbDirtySyncKeysForApp } from "../tursoSyncState.js";
import { SyncStateManager } from "./syncState.js";

const QUEUED_DIRS = ["apps", "Jobs"] as const;

export function listPendingUploadRelativePaths(
  paprDir: string,
  stateManager: SyncStateManager,
): string[] {
  const pending: string[] = [];
  for (const parent of QUEUED_DIRS) {
    const parentPath = path.join(paprDir, parent);
    if (!fs.existsSync(parentPath)) {
      continue;
    }
    for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const relativePath = `${parent}/${entry.name}`;
      if (stateManager.hasItemChanged(relativePath)) {
        pending.push(relativePath);
      }
    }
  }
  return pending;
}

export function hasPendingLocalUploads(
  paprDir: string,
  stateManager: SyncStateManager,
): boolean {
  return listPendingUploadRelativePaths(paprDir, stateManager).length > 0;
}

export function appHasPendingLocalUpload(
  appId: string,
  stateManager: SyncStateManager,
): boolean {
  return stateManager.hasItemChanged(`apps/${appId}`);
}

/** True when ordered flush (migrations → Turso → writer → publish) has work for this app. */
export function appNeedsOrderedFlush(
  sync: Pick<CloudSyncService, "getPaprDir" | "hasRelativePathChanged">,
  appId: string,
): boolean {
  const paprDir = sync.getPaprDir();
  if (sync.hasRelativePathChanged(`apps/${appId}`)) {
    return true;
  }
  const syncKeys = listAppLinkedSyncKeys(appId, paprDir);
  return listDbDirtySyncKeysForApp(syncKeys, paprDir).length > 0;
}

/** Plan A replica: unpushed CDC ops or last push error on a linked registry DB. */
export async function appHasReplicaPendingPush(
  appId: string,
  paprDir: string,
): Promise<boolean> {
  const appsRoot = path.join(paprDir, "apps");
  const { discoverTursoLinkedSources, linkedSourceAsAppDataSource } =
    await import("../tursoLinkedSources.js");
  const { shouldUseTursoReplicaForSource, syncStatusForLinkedDb } =
    await import("../tursoReplica/tursoReplicaRouting.js");

  const linked = await discoverTursoLinkedSources(appsRoot);
  for (const source of linked) {
    if (source.appId !== appId) {
      continue;
    }
    const appSource = linkedSourceAsAppDataSource(source);
    if (!shouldUseTursoReplicaForSource(appSource)) {
      continue;
    }
    try {
      const status = await syncStatusForLinkedDb(appSource);
      if (
        status.pendingPush ||
        status.pendingOps > 0 ||
        (status.lastPushError?.trim().length ?? 0) > 0
      ) {
        return true;
      }
    } catch {
      /* status is best-effort */
    }
  }
  return false;
}

/** True when any linked Turso source for this app has local/remote schema drift. */
export async function appHasLinkedSchemaDrift(
  appId: string,
  paprDir: string,
): Promise<boolean> {
  const syncKeys = listAppLinkedSyncKeys(appId, paprDir);
  if (syncKeys.size === 0) {
    return false;
  }
  const appsRoot = path.join(paprDir, "apps");
  const { buildTursoSyncItemsReport } = await import("../tursoSyncStatus.js");
  const report = await buildTursoSyncItemsReport(appsRoot, appId);
  return report.sources.some(
    (source) => syncKeys.has(source.jobId) && source.schemaDrift === true,
  );
}

/** Git/db dirty flags, Plan A replica pending push, and Turso schema drift. */
export async function appNeedsOrderedFlushAsync(
  sync: Pick<CloudSyncService, "getPaprDir" | "hasRelativePathChanged">,
  appId: string,
): Promise<boolean> {
  if (appNeedsOrderedFlush(sync, appId)) {
    return true;
  }
  const paprDir = sync.getPaprDir();
  if (await appHasReplicaPendingPush(appId, paprDir)) {
    return true;
  }
  return appHasLinkedSchemaDrift(appId, paprDir);
}

/** Load sync state from disk and check whether a mini-app still has unpushed git work. */
export function readAppHasPendingLocalUpload(
  appId: string,
  paprDir: string,
): boolean {
  const mgr = new SyncStateManager(paprDir);
  mgr.load();
  return appHasPendingLocalUpload(appId, mgr);
}

export function formatPendingUploadDeferReason(
  pendingPaths: readonly string[],
): string {
  if (pendingPaths.length === 0) {
    return "pending local upload(s)";
  }
  const preview = pendingPaths.slice(0, 3).join(", ");
  const suffix =
    pendingPaths.length > 3 ? ` (+${pendingPaths.length - 3} more)` : "";
  return `pending local upload(s): ${preview}${suffix}`;
}
