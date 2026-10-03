/**
 * Per-app "unpublished changes" flag — set when an edit lands, cleared when a
 * publish succeeds. Status reads are O(1).
 *
 * Mirrors the DB dirty flag (tursoSyncState.markDbDirty): the edit side
 * confirms there is real unsent work before setting the flag, so a file
 * re-saved with identical bytes never shows "Unpublished changes".
 *
 * - Edit: the app tree watcher reports every changed path. After the burst
 *   settles, only those paths are compared to the blob OIDs the cloud last
 *   acknowledged (OidCache). Differing paths go into the app's dirty set.
 * - Publish: the dirty set is re-checked against the fresh OIDs (files held
 *   back by the batch budget stay dirty) and the unknown marker is dropped.
 * - Startup / edits made while Paprwork was closed: each app is reconciled
 *   once per process with the cheap folder hash; only if that trips does the
 *   bounded content check run (confirmAppUnchangedSinceUpload).
 * - If the watcher is not running (cloud sandbox, watcher failure), every read
 *   falls back to that reconcile path so nothing is ever reported published
 *   when it is not.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { notifyCloudSyncItemsStale } from "../cloudSync/cloudSyncBroadcast.js";
import { isTooLargeForGitSync } from "../cloudSync/gitSyncLimits.js";
import {
  isExcludedFromFolderContentHash,
  type SyncStateManager,
} from "../cloudSync/syncState.js";
import { computeBlobOidForContent } from "./computeParentHash.js";
import { confirmAppUnchangedSinceUpload } from "./confirmAppUnchangedSinceUpload.js";
import { readOidCache } from "./OidCache.js";

/** Dirty set entry meaning "changed, but we don't know which files" (startup reconcile). */
export const UNKNOWN_DIRTY = "*";
const EVAL_SETTLE_MS = 400;

const dirty = new Map<string, Set<string>>();
const reconciled = new Set<string>();
const reconciling = new Map<string, Promise<void>>();
const pending = new Map<string, { timer: NodeJS.Timeout; paths: Set<string> }>();
const evalChain = new Map<string, Promise<void>>();
let trackingActive = false;

function dirtySet(appId: string): Set<string> {
  let set = dirty.get(appId);
  if (!set) {
    set = new Set();
    dirty.set(appId, set);
  }
  return set;
}

function isDirtyNow(appId: string): boolean {
  return (dirty.get(appId)?.size ?? 0) > 0;
}

/** True when the path counts toward "unpublished changes" (same rules as the folder hash). */
export function isTrackedAppPath(appId: string, repoPath: string): boolean {
  return !isExcludedFromFolderContentHash(`apps/${appId}/${repoPath.replace(/\\/g, "/")}`);
}

/** Watcher on/off. Turning on forgets prior reconciles: edits in the gap were not seen. */
export function setAppEditTrackingActive(active: boolean): void {
  if (active && !trackingActive) reconciled.clear();
  trackingActive = active;
}

/** Does this path's content differ from what the cloud last acknowledged? */
async function pathDiffersFromUpload(
  paprDir: string,
  appId: string,
  repoPath: string,
  uploadedOids: Readonly<Record<string, string>>,
): Promise<boolean> {
  const fullPath = path.join(paprDir, "apps", appId, repoPath);
  const stat = await fs.stat(fullPath).catch(() => null);
  if (!stat?.isFile()) return repoPath in uploadedOids; // deleted after upload
  if (isTooLargeForGitSync(stat.size)) return false; // publish never sends it
  const uploaded = uploadedOids[repoPath];
  if (!uploaded) return true;
  const content = await fs.readFile(fullPath, "utf8").catch(() => null);
  if (content === null) return true;
  return (await computeBlobOidForContent(content)) !== uploaded;
}

/** Re-check the given paths; add differing ones to the dirty set, drop matching ones. */
async function evaluatePaths(
  paprDir: string,
  appId: string,
  paths: Iterable<string>,
): Promise<void> {
  const before = isDirtyNow(appId);
  const uploadedOids = (await readOidCache()).apps[appId] ?? {};
  const set = dirtySet(appId);
  for (const repoPath of paths) {
    if (repoPath === UNKNOWN_DIRTY) continue;
    if (await pathDiffersFromUpload(paprDir, appId, repoPath, uploadedOids)) {
      set.add(repoPath);
    } else {
      set.delete(repoPath);
    }
  }
  if (before !== isDirtyNow(appId)) notifyCloudSyncItemsStale(appId);
}

function runSerial(appId: string, work: () => Promise<void>): Promise<void> {
  const next = (evalChain.get(appId) ?? Promise.resolve()).then(work, work);
  const settled = next.catch((err: unknown) => {
    console.warn(`[AppDirty] ${appId}:`, err instanceof Error ? err.message : err);
  });
  evalChain.set(appId, settled);
  return settled;
}

function flushPending(paprDir: string, appId: string): Promise<void> {
  const entry = pending.get(appId);
  if (!entry) return evalChain.get(appId) ?? Promise.resolve();
  clearTimeout(entry.timer);
  pending.delete(appId);
  return runSerial(appId, () => evaluatePaths(paprDir, appId, entry.paths));
}

/** Watcher hook: a file under apps/{appId}/ was added, changed or deleted. */
export function noteAppPathEdited(paprDir: string, appId: string, repoPath: string): void {
  const normalized = repoPath.replace(/\\/g, "/");
  if (!isTrackedAppPath(appId, normalized)) return;
  const entry = pending.get(appId);
  if (entry) {
    clearTimeout(entry.timer);
    entry.paths.add(normalized);
  }
  const paths = entry?.paths ?? new Set([normalized]);
  pending.set(appId, {
    paths,
    timer: setTimeout(() => void flushPending(paprDir, appId), EVAL_SETTLE_MS),
  });
}

/** Startup / gap reconcile: cheap folder hash, bounded content check only if it trips. */
async function reconcileApp(
  paprDir: string,
  appId: string,
  stateManager: SyncStateManager,
): Promise<void> {
  const relativePath = `apps/${appId}`;
  const prev = stateManager.data.syncedItems[relativePath];
  const currentHash = stateManager.computeContentHash(relativePath);
  const changed =
    (!prev || prev.contentHash !== currentHash) &&
    !(await confirmAppUnchangedSinceUpload(paprDir, appId, stateManager, currentHash));
  if (changed) dirtySet(appId).add(UNKNOWN_DIRTY);
  reconciled.add(appId);
}

function ensureReconciled(
  paprDir: string,
  appId: string,
  stateManager: SyncStateManager,
): Promise<void> {
  if (reconciled.has(appId)) return Promise.resolve();
  let inflight = reconciling.get(appId);
  if (!inflight) {
    inflight = runSerial(appId, () => reconcileApp(paprDir, appId, stateManager)).finally(
      () => reconciling.delete(appId),
    );
    reconciling.set(appId, inflight);
  }
  return inflight;
}

/** Status / Publish button: does this app have unpublished changes? */
export async function isAppDirty(
  paprDir: string,
  appId: string,
  stateManager: SyncStateManager,
): Promise<boolean> {
  if (!trackingActive) {
    reconciled.delete(appId);
    dirty.delete(appId);
    await reconcileApp(paprDir, appId, stateManager);
    return isDirtyNow(appId);
  }
  await ensureReconciled(paprDir, appId, stateManager);
  await flushPending(paprDir, appId);
  return isDirtyNow(appId);
}

/**
 * Synchronous read for flush planning. Before an app is reconciled (or with
 * no watcher) it answers with the cheap folder hash, as before, and kicks off
 * a background reconcile so the next read is O(1).
 */
export function isAppDirtySync(
  paprDir: string,
  appId: string,
  stateManager: SyncStateManager,
): boolean {
  if (trackingActive && reconciled.has(appId)) {
    return isDirtyNow(appId) || pending.has(appId);
  }
  if (trackingActive) void ensureReconciled(paprDir, appId, stateManager);
  return stateManager.hasItemChanged(`apps/${appId}`);
}

/** Publish succeeded: drop the unknown marker, re-check the rest against fresh OIDs. */
export function markAppPublished(paprDir: string, appId: string): Promise<void> {
  const set = dirty.get(appId);
  set?.delete(UNKNOWN_DIRTY);
  reconciled.add(appId);
  if (!set || set.size === 0) {
    notifyCloudSyncItemsStale(appId);
    return Promise.resolve();
  }
  return runSerial(appId, () => evaluatePaths(paprDir, appId, [...set]));
}

/** OIDs changed without a publish (Get updates): re-check dirty paths. */
export function revalidateAppDirty(paprDir: string, appId: string): Promise<void> {
  const set = dirty.get(appId);
  if (!set || set.size === 0) return Promise.resolve();
  return runSerial(appId, () => evaluatePaths(paprDir, appId, [...set]));
}

/** Test hook. */
export function resetAppDirtyStateForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  dirty.clear();
  reconciled.clear();
  reconciling.clear();
  evalChain.clear();
  trackingActive = false;
}

/** Test hook: wait for queued evaluation for an app. */
export function flushAppDirtyForTests(paprDir: string, appId: string): Promise<void> {
  return flushPending(paprDir, appId);
}
