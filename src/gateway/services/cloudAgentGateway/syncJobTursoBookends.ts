import fs from "fs";
import {
  createRemoteClient,
  ensureLocalDbChangeLogReady,
  localDbHasSyncableUserTables,
  pullTursoToLocalDb,
  type PushResult,
} from "../tursoSyncBridgeCore.js";
import { loadTursoSyncState } from "../tursoSyncState.js";
import { alignMigrationLedgers } from "../jobs/jobMigrationLedgerSync.js";
import { resolveMigrationRootFromDbPath } from "../jobs/jobMigrationTursoSync.js";
import {
  pushLinkedSourceWithDesktopParity,
  type LinkedSourcePushState,
} from "../tursoLinkedSourcePush.js";

/** Sync state key — job id or registry dbId (matches TursoSyncBridge linkedSourceSyncKey). */
export interface TursoBookendTarget {
  syncKey: string;
  dbPath: string;
  tursoUrl: string;
  authToken: string;
  /** For jobs:db-changed SSE on apps.papr.ai */
  jobId?: string;
  dbId?: string;
}

function credentialsForTarget(target: TursoBookendTarget): {
  tursoUrl: string;
  authToken: string;
} {
  return {
    tursoUrl: target.tursoUrl,
    authToken: target.authToken,
  };
}

function pushStateForTarget(
  syncKey: string,
  freshLocalDb: boolean,
): LinkedSourcePushState | undefined {
  const state = loadTursoSyncState();
  const sourceState = state.jobs[syncKey];
  if (!sourceState || freshLocalDb) {
    return undefined;
  }
  return {
    ...(sourceState.tableFingerprints
      ? { tableFingerprints: sourceState.tableFingerprints }
      : {}),
    ...(sourceState.lastPushedLogId !== undefined
      ? { lastPushedLogId: sourceState.lastPushedLogId }
      : {}),
  };
}

export async function pullLinkedSourceFromCloud(
  input: TursoBookendTarget,
): Promise<void> {
  const creds = credentialsForTarget(input);
  const state = loadTursoSyncState();
  const sourceState = state.jobs[input.syncKey];
  const freshLocalDb = !localDbHasSyncableUserTables(input.dbPath);
  if (freshLocalDb && sourceState) {
    console.log(
      `[CloudTursoBookends] Fresh local DB for ${input.syncKey} — ignoring git sync cursors`,
    );
  }
  await pullTursoToLocalDb(input.dbPath, creds, {
    jobId: input.syncKey,
    ...(!freshLocalDb && sourceState?.lastPulledLogId !== undefined
      ? { lastPulledLogId: sourceState.lastPulledLogId }
      : {}),
    ...(!freshLocalDb && sourceState?.lastSeenRemoteVersion !== undefined
      ? { lastSeenRemoteVersion: sourceState.lastSeenRemoteVersion }
      : {}),
  });
  ensureLocalDbChangeLogReady(input.dbPath);

  const migrationRoot = resolveMigrationRootFromDbPath(input.dbPath);
  if (migrationRoot && fs.existsSync(input.dbPath)) {
    const ledgerRemote = createRemoteClient(creds);
    try {
      await alignMigrationLedgers(ledgerRemote, input.dbPath, migrationRoot);
    } finally {
      ledgerRemote.close();
    }
  }
}

export async function pushLinkedSourceToCloud(
  input: TursoBookendTarget,
): Promise<PushResult> {
  const creds = credentialsForTarget(input);
  const freshLocalDb = !localDbHasSyncableUserTables(input.dbPath);
  return pushLinkedSourceWithDesktopParity({
    syncKey: input.syncKey,
    dbPath: input.dbPath,
    credentials: creds,
    state: pushStateForTarget(input.syncKey, freshLocalDb),
  });
}

/** @deprecated Use pullLinkedSourceFromCloud — job-owned DB only. */
export async function pullJobTursoFromCloud(input: {
  jobId: string;
  tursoUrl: string;
  authToken: string;
}): Promise<void> {
  const { getPaprJobsRoot } = await import("../../../core/utils/paprRoot.js");
  const dbPath = `${getPaprJobsRoot()}/${input.jobId}/data/data.db`;
  await pullLinkedSourceFromCloud({
    syncKey: input.jobId,
    dbPath,
    tursoUrl: input.tursoUrl,
    authToken: input.authToken,
  });
}

/** @deprecated Use pushLinkedSourceToCloud — job-owned DB only. */
export async function pushJobTursoToCloud(input: {
  jobId: string;
  tursoUrl: string;
  authToken: string;
}): Promise<PushResult> {
  const { getPaprJobsRoot } = await import("../../../core/utils/paprRoot.js");
  const dbPath = `${getPaprJobsRoot()}/${input.jobId}/data/data.db`;
  return pushLinkedSourceToCloud({
    syncKey: input.jobId,
    dbPath,
    tursoUrl: input.tursoUrl,
    authToken: input.authToken,
  });
}
