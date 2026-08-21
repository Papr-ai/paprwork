import fs from "fs";
import {
  createRemoteClient,
  ensureLocalDbChangeLogReady,
  localDbHasSyncableUserTables,
  type PushResult,
} from "../tursoSyncBridgeCore.js";
import { loadTursoSyncState } from "../tursoSyncState.js";
import { alignMigrationLedgers } from "../jobs/jobMigrationLedgerSync.js";
import { resolveMigrationRootFromDbPath } from "../jobs/jobMigrationTursoSync.js";
import type { TursoLinkedSource } from "../tursoLinkedSources.js";
import {
  pullLinkedSourceViaWorkspaceLog,
  pushLinkedSourceViaWorkspaceLog,
} from "../syncV3/workspaceLogSync.js";

/** Sync state key — job id or registry dbId (matches TursoSyncBridge linkedSourceSyncKey). */
export interface TursoBookendTarget {
  syncKey: string;
  dbPath: string;
  tursoUrl: string;
  authToken: string;
  /** Owning mini-app — required for workspace log row sync. */
  appId?: string;
  /** For jobs:db-changed SSE on apps.papr.ai */
  jobId?: string;
  dbId?: string;
}

function bookendToLinkedSource(target: TursoBookendTarget): TursoLinkedSource | null {
  const appId = target.appId?.trim() || process.env.APP_ID?.trim();
  if (!appId) {
    return null;
  }
  const alias = target.dbId ?? target.jobId ?? target.syncKey;
  return {
    appId,
    dbPath: target.dbPath,
    alias,
    ...(target.jobId ? { jobId: target.jobId } : {}),
    ...(target.dbId ? { dbId: target.dbId } : {}),
  };
}

export async function pullLinkedSourceFromCloud(
  input: TursoBookendTarget,
): Promise<void> {
  const linked = bookendToLinkedSource(input);
  const freshLocalDb = !localDbHasSyncableUserTables(input.dbPath);
  if (freshLocalDb) {
    const state = loadTursoSyncState();
    const sourceState = state.jobs[input.syncKey];
    if (sourceState) {
      console.log(
        `[CloudTursoBookends] Fresh local DB for ${input.syncKey} — ignoring sync cursors`,
      );
    }
  }

  if (linked) {
    await pullLinkedSourceViaWorkspaceLog(linked);
  }

  ensureLocalDbChangeLogReady(input.dbPath);

  const migrationRoot = resolveMigrationRootFromDbPath(input.dbPath);
  if (migrationRoot && fs.existsSync(input.dbPath)) {
    const creds = {
      tursoUrl: input.tursoUrl,
      authToken: input.authToken,
    };
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
  const linked = bookendToLinkedSource(input);
  if (!linked) {
    return {
      status: "failed",
      tables: [],
      error: "appId required for workspace log push",
    };
  }
  return pushLinkedSourceViaWorkspaceLog(linked);
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
    appId: process.env.APP_ID,
    jobId: input.jobId,
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
    appId: process.env.APP_ID,
    jobId: input.jobId,
  });
}
