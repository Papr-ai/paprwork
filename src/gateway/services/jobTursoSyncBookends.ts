/**
 * Desktop job Turso bookends — pull remote rows before run, push writeDbIds after.
 *
 * Web mini-apps write to Turso via /api/db/*. Desktop jobs read/write local SQLite.
 * Without a pre-run pull, agent jobs miss web-created rows; without post-run push
 * keyed by writeDbIds, registry DBs never sync (push by job UUID skips db-* sources).
 */

import type { JobRecord } from "./jobs/types.js";
import { resolveJobWriteTargets } from "./jobAppDatabase.js";
import { findLinkedSourceForJob } from "./tursoLinkedSources.js";
import { getTursoSyncBridge } from "./TursoSyncBridge.js";
import { ensureLocalDbChangeLogReady } from "./tursoSyncBridgeCore.js";
import { getSyncCoordinator } from "./cloudSync/SyncCoordinator.js";

export function resolveJobTursoSyncKeys(
  job: Pick<JobRecord, "id" | "writeDbIds">,
): string[] {
  const keys = new Set<string>();
  for (const dbId of job.writeDbIds ?? []) {
    const trimmed = dbId.trim();
    if (trimmed) {
      keys.add(trimmed);
    }
  }
  if (keys.size === 0) {
    keys.add(job.id);
  }
  return [...keys];
}

/** Includes legacy app primary registry dbId when writeDbIds is empty. */
export async function resolveJobTursoSyncKeysAsync(
  job: Pick<JobRecord, "id" | "writeDbIds" | "appIds">,
): Promise<string[]> {
  const keys = new Set<string>();
  for (const dbId of job.writeDbIds ?? []) {
    const trimmed = dbId.trim();
    if (trimmed) {
      keys.add(trimmed);
    }
  }

  if (keys.size === 0) {
    try {
      const targets = await resolveJobWriteTargets(job);
      for (const target of targets) {
        keys.add(target.dbId);
      }
    } catch {
      // Registry missing — fall back to job id below.
    }
  }

  if (keys.size === 0) {
    keys.add(job.id);
  }

  return [...keys];
}

export async function pullJobTursoBeforeRun(
  job: Pick<JobRecord, "id" | "writeDbIds" | "appIds" | "name">,
  appendLog?: (line: string) => Promise<void>,
): Promise<void> {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    return;
  }

  const syncKeys = await resolveJobTursoSyncKeysAsync(job);
  const sources = await bridge.listLinkedSources();

  for (const syncKey of syncKeys) {
    const linked = findLinkedSourceForJob(sources, syncKey);
    if (!linked) {
      await appendLog?.(
        `[Turso] No linked app database for ${syncKey} — skip pre-run pull`,
      );
      continue;
    }

    try {
      const result = await bridge.pullJob(syncKey, undefined, {});
      if (result.status === "pulled") {
        ensureLocalDbChangeLogReady(linked.dbPath);
        await appendLog?.(
          `[Turso] Pulled remote DB before run (${syncKey})`,
        );
      } else {
        await appendLog?.(
          `[Turso] Pre-run pull skipped for ${syncKey}: ${result.reason ?? result.status}`,
        );
      }
    } catch (error) {
      const message = (error as Error).message.slice(0, 160);
      await appendLog?.(`[Turso] Pre-run pull failed for ${syncKey}: ${message}`);
      console.warn(
        `[JobTursoBookends] Pre-run pull failed for ${syncKey}:`,
        message,
      );
    }
  }
}

export async function scheduleJobTursoPushAfterRun(
  job: Pick<JobRecord, "id" | "writeDbIds" | "appIds">,
): Promise<void> {
  const bridge = getTursoSyncBridge();
  const syncKeys = await resolveJobTursoSyncKeysAsync(job);
  const coordinator = getSyncCoordinator();
  const sources = bridge ? await bridge.listLinkedSources(true) : [];

  for (const syncKey of syncKeys) {
    if (coordinator) {
      const linked = findLinkedSourceForJob(sources, syncKey);
      if (linked) {
        coordinator.markDbDirty(syncKey, linked.dbPath, "completion");
        continue;
      }
    }
    const { scheduleTursoPushForJob } = await import("./tursoPushScheduler.js");
    scheduleTursoPushForJob(syncKey, "completion", "completion");
  }
}

/** Debounced push after job completion — uses writeDbIds sync keys when set. */
export async function pushJobTursoIfEnabled(
  job: Pick<JobRecord, "id" | "writeDbIds" | "appIds">,
): Promise<void> {
  await scheduleJobTursoPushAfterRun(job);
}
