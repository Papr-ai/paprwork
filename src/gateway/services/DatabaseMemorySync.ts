/**
 * Registry-keyed Papr Memory sync for linked databases.
 *
 * JobDatabaseMemorySync fires only after local job runs — team/cloud writes
 * pulled from Turso and standalone registry databases (d-{dbId8}, no owning
 * job run) were never re-indexed, so their memory summaries went stale.
 *
 * This service subscribes to jobs:db-changed events (published by the linked
 * DB watcher and after Turso pulls), debounces per database, and snapshots to
 * memory only when content actually changed. The content-hash gate is shared
 * with JobDatabaseMemorySync so the two paths never double-write memories.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import Papr from "@papr/memory";
import type { DbChangedData, JobEvent } from "../../core/types/jobEvents.js";
import { getPaprDataDir, getPaprJobsRoot } from "../../core/utils/paprRoot.js";
import { getApiKey } from "../utils/keyResolver.js";
import { paprMemoryScopeSpread } from "../utils/memoryScopeResolver.js";
import { getJobEventHub } from "./JobEventHub.js";
import {
  extractJobDatabaseSnapshots,
  type TableSnapshot,
} from "./JobDatabaseMemorySync.js";
import { computeSyncableTableFingerprintsForPath } from "./tursoTableFingerprint.js";

const STATE_FILENAME = ".db-memory-sync-state.json";
const DEBOUNCE_MS = 5 * 60_000;
const MAX_TOTAL_CHARS = 8000;

interface MemorySyncStateFile {
  /** normalized dbPath → content hash at last successful memory sync */
  databases: Record<string, { hash: string; lastSyncAt: string }>;
}

function statePath(): string {
  return path.join(getPaprDataDir(), STATE_FILENAME);
}

function loadState(): MemorySyncStateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8")) as MemorySyncStateFile;
    if (parsed && typeof parsed === "object" && parsed.databases) {
      return parsed;
    }
  } catch {
    /* first run */
  }
  return { databases: {} };
}

function saveState(state: MemorySyncStateFile): void {
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(state, null, 2), "utf8");
}

function contentHashForDb(dbPath: string): string | null {
  const fingerprints = computeSyncableTableFingerprintsForPath(dbPath);
  if (!fingerprints || Object.keys(fingerprints).length === 0) {
    return null;
  }
  const sorted = Object.keys(fingerprints)
    .sort()
    .map((key) => `${key}=${fingerprints[key]}`)
    .join(";");
  return createHash("sha256").update(sorted).digest("hex");
}

/**
 * Shared gate: has this database's content changed since the last memory sync?
 * Returns the current hash so callers can record it after a successful sync.
 */
export function shouldSyncDatabaseToMemory(dbPath: string): {
  changed: boolean;
  hash: string | null;
} {
  const hash = contentHashForDb(dbPath);
  if (hash === null) {
    return { changed: false, hash: null };
  }
  const state = loadState();
  const previous = state.databases[path.normalize(dbPath)];
  return { changed: previous?.hash !== hash, hash };
}

export function recordDatabaseMemorySynced(dbPath: string, hash?: string | null): void {
  const resolved = hash ?? contentHashForDb(dbPath);
  if (!resolved) {
    return;
  }
  const state = loadState();
  state.databases[path.normalize(dbPath)] = {
    hash: resolved,
    lastSyncAt: new Date().toISOString(),
  };
  saveState(state);
}

interface SyncTarget {
  key: string;
  dbPath: string;
  label: string;
  dbId?: string;
  jobId?: string;
}

async function resolveTarget(data: DbChangedData): Promise<SyncTarget | null> {
  const { getDatabaseRegistryService } = await import("./DatabaseRegistryService.js");
  const registry = getDatabaseRegistryService();
  if (data.dbId) {
    const record = registry.getById(data.dbId);
    if (record && record.status === "active") {
      return {
        key: data.dbId,
        dbPath: record.localPath,
        label: record.label ?? data.dbId,
        dbId: data.dbId,
        ...(record.ownerJobId ? { jobId: record.ownerJobId } : {}),
      };
    }
    return null;
  }
  if (data.jobId) {
    const dbPath = path.join(getPaprJobsRoot(), data.jobId, "data", "data.db");
    const record = registry.getByPath(dbPath);
    return {
      key: data.jobId,
      dbPath,
      label: record?.label ?? `job ${data.jobId}`,
      jobId: data.jobId,
      ...(record ? { dbId: record.dbId } : {}),
    };
  }
  return null;
}

function buildSnapshotContent(target: SyncTarget, snapshots: TableSnapshot[]): string {
  const header = [
    `Database snapshot: ${target.label}`,
    ...(target.dbId ? [`Database ID: ${target.dbId}`] : []),
    ...(target.jobId ? [`Job ID: ${target.jobId}`] : []),
    "",
  ].join("\n");
  const body = snapshots
    .map((snap) => {
      const note =
        snap.rowCount > snap.sampleRows.length
          ? ` (showing ${snap.sampleRows.length} of ${snap.rowCount} rows)`
          : "";
      return [
        `## Table: ${snap.table}${note}`,
        "```json",
        JSON.stringify(snap.sampleRows, null, 2),
        "```",
      ].join("\n");
    })
    .join("\n\n");
  const content = `${header}\n${body}`;
  return content.length <= MAX_TOTAL_CHARS
    ? content
    : `${content.slice(0, MAX_TOTAL_CHARS)}\n\n[... truncated for memory limits ...]`;
}

function buildSummaryContent(target: SyncTarget, snapshots: TableSnapshot[]): string {
  const today = new Date().toISOString().split("T")[0];
  const lines: string[] = [`${target.label} — Database Summary (${today})`, ""];
  for (const snap of snapshots) {
    const colPreview = snap.columns.slice(0, 6).join(", ");
    const colSuffix = snap.columns.length > 6 ? ", ..." : "";
    lines.push(
      `- **${snap.table}**: ${snap.rowCount} rows, ${snap.columns.length} columns (${colPreview}${colSuffix}).`,
    );
  }
  return lines.join("\n");
}

async function syncTargetToMemory(target: SyncTarget): Promise<boolean> {
  try {
    if (!fs.existsSync(target.dbPath) || fs.statSync(target.dbPath).size === 0) {
      return false;
    }
    const gate = shouldSyncDatabaseToMemory(target.dbPath);
    if (!gate.changed) {
      return false;
    }
    const snapshots = extractJobDatabaseSnapshots(target.dbPath);
    if (!snapshots || snapshots.length === 0) {
      return false;
    }
    const apiKey = await getApiKey("PAPR_API_KEY");
    if (!apiKey) {
      return false;
    }

    const client = new Papr({ xAPIKey: apiKey, maxRetries: 2, timeout: 30000 });
    const syncDate = new Date().toISOString().split("T")[0];
    const shared = {
      sync_date: syncDate,
      ...(target.dbId ? { dbId: target.dbId } : {}),
      ...(target.jobId ? { jobId: target.jobId } : {}),
      dbLabel: target.label,
      tables: snapshots.map((s) => s.table).join(","),
      tableCount: String(snapshots.length),
    };

    const memoryScope = await paprMemoryScopeSpread();

    await client.memory.add({
      content: buildSnapshotContent(target, snapshots),
      ...memoryScope,
      metadata: {
        role: "assistant",
        category: "fact",
        customMetadata: {
          source: "database_snapshot",
          content_type: "database_snapshot",
          ...shared,
        },
      },
    });
    await client.memory.add({
      content: buildSummaryContent(target, snapshots),
      ...memoryScope,
      metadata: {
        role: "assistant",
        category: "fact",
        customMetadata: {
          source: "database_summary",
          content_type: "database_summary",
          ...shared,
        },
      },
    });

    recordDatabaseMemorySynced(target.dbPath, gate.hash);
    return true;
  } catch (error) {
    console.warn(
      `[DatabaseMemorySync] Sync failed for ${target.key}:`,
      (error as Error).message.slice(0, 120),
    );
    return false;
  }
}

const debounceTimers = new Map<string, NodeJS.Timeout>();
let unsubscribe: (() => void) | null = null;

function onDbChanged(data: DbChangedData): void {
  const key = data.dbId ?? data.jobId;
  if (!key) {
    return;
  }
  const existing = debounceTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    void resolveTarget(data)
      .then((target) => (target ? syncTargetToMemory(target) : false))
      .catch(() => false);
  }, DEBOUNCE_MS);
  timer.unref?.();
  debounceTimers.set(key, timer);
}

/** Subscribe to db-changed events; debounced, content-gated memory sync. */
export function startDatabaseMemorySync(): void {
  if (unsubscribe) {
    return;
  }
  unsubscribe = getJobEventHub().subscribe((event: JobEvent) => {
    if (event.type === "jobs:db-changed") {
      onDbChanged(event.data as DbChangedData);
    }
  });
}

export function stopDatabaseMemorySync(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  unsubscribe?.();
  unsubscribe = null;
}
