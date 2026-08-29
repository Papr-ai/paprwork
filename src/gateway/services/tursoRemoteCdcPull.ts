/**
 * Pull Turso primary changelog (_papr_sync_log) into local SQLite for legacy
 * linked sources. Used when cloud writes hit Turso directly (not workspace log).
 */

import * as fs from "fs";
import * as path from "path";
import {
  createRemoteClient,
  ensureLocalDbChangeLogReady,
  openWritableLocalJobDb,
  readRemoteSyncVersion,
  type PullResult,
  type TursoCredentials,
} from "./tursoSyncBridgeCore.js";
import { applyRemoteSyncLogToLocal } from "./tursoDeltaSync.js";
import {
  linkedSourceAlternateKeys,
  linkedSourceSyncKey,
  type TursoLinkedSource,
} from "./tursoLinkedSources.js";
import {
  compactSyncLogEntries,
  LOG_BATCH_LIMIT,
  readRemoteSyncLogSince,
  remoteSyncLogExists,
  withSyncMutedAsync,
} from "./tursoSyncLog.js";
import {
  ensureLocalPullSyncInfrastructure,
  reconcileFingerprintDriftAfterDeltaPull,
} from "./tursoPullReconcile.js";
import {
  isJobDbDirty,
  loadTursoSyncState,
  recordTursoRemoteVersion,
  resolveTursoPushStateEntry,
} from "./tursoSyncState.js";

/** Apply remote Turso CDC entries to a legacy linked local database. */
export async function pullLinkedSourceViaTursoRemoteCdc(
  linked: TursoLinkedSource,
  credentials: TursoCredentials,
): Promise<PullResult> {
  const syncKey = linkedSourceSyncKey(linked);
  const dbPath = linked.dbPath;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, "");
  }

  ensureLocalDbChangeLogReady(dbPath);

  const state = loadTursoSyncState();
  const alternateKeys = linkedSourceAlternateKeys(linked);
  if (isJobDbDirty(syncKey, dbPath, state, alternateKeys)) {
    return { status: "skipped", reason: "local_db_dirty" };
  }

  const jobState = resolveTursoPushStateEntry(syncKey, dbPath, state, alternateKeys);
  const lastPulledLogId = jobState?.lastPulledLogId ?? 0;

  const remote = createRemoteClient(credentials);
  try {
    const hasRemoteLog = await remoteSyncLogExists(remote);
    if (!hasRemoteLog) {
      return { status: "skipped", reason: "remote_changelog_missing" };
    }

    let remoteEntries = await readRemoteSyncLogSince(remote, lastPulledLogId);
    if (remoteEntries.length === 0) {
      const remoteVersion = (await readRemoteSyncVersion(remote)) ?? undefined;
      if (
        remoteVersion !== undefined &&
        jobState?.lastSeenRemoteVersion !== undefined &&
        remoteVersion <= jobState.lastSeenRemoteVersion
      ) {
        return { status: "skipped", reason: "remote_unchanged" };
      }
      return { status: "skipped", reason: "no_remote_changelog_entries" };
    }

    const allEntries = [...remoteEntries];
    while (remoteEntries.length >= LOG_BATCH_LIMIT) {
      const cursor = remoteEntries[remoteEntries.length - 1]?.id ?? lastPulledLogId;
      remoteEntries = await readRemoteSyncLogSince(remote, cursor);
      if (remoteEntries.length === 0) {
        break;
      }
      allEntries.push(...remoteEntries);
    }

    const localDb = openWritableLocalJobDb(dbPath);
    try {
      ensureLocalPullSyncInfrastructure(localDb);
      const compacted = compactSyncLogEntries(allEntries);
      const touched = await withSyncMutedAsync(localDb, async () =>
        applyRemoteSyncLogToLocal(localDb, remote, compacted),
      );

      const maxLogId = allEntries.reduce(
        (max, entry) => (entry.id > max ? entry.id : max),
        lastPulledLogId,
      );
      const remoteVersion = (await readRemoteSyncVersion(remote)) ?? 0;
      recordTursoRemoteVersion(syncKey, dbPath, remoteVersion, undefined, {
        lastPulledLogId: maxLogId,
      });

      if (touched.length > 0) {
        await reconcileFingerprintDriftAfterDeltaPull(localDb, remote, touched);
      }

      console.log(
        `[TursoRemoteCdcPull] Applied ${compacted.length} remote changelog entry(ies) ` +
          `for ${syncKey} (${touched.length} table(s))`,
      );

      return {
        status: "pulled",
        tables: touched.length > 0 ? touched : ["*"],
        syncMode: "legacy-cdc",
      };
    } finally {
      localDb.close();
    }
  } catch (error) {
    return {
      status: "failed",
      error: (error as Error).message.slice(0, 300),
      syncMode: "legacy-cdc",
    };
  } finally {
    remote.close();
  }
}
