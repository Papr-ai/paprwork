import {
  pullTursoToLocalDb,
  pushLocalDbToTurso,
} from "../tursoSyncBridgeCore.js";
import { loadTursoSyncState } from "../tursoSyncState.js";

/** Sync state key — job id or registry dbId (matches TursoSyncBridge linkedSourceSyncKey). */
export interface TursoBookendTarget {
  syncKey: string;
  dbPath: string;
  tursoUrl: string;
  authToken: string;
}

export async function pullLinkedSourceFromCloud(
  input: TursoBookendTarget,
): Promise<void> {
  const creds = {
    tursoUrl: input.tursoUrl,
    authToken: input.authToken,
  };
  const state = loadTursoSyncState();
  const sourceState = state.jobs[input.syncKey];
  await pullTursoToLocalDb(input.dbPath, creds, {
    jobId: input.syncKey,
    ...(sourceState?.lastPulledLogId !== undefined
      ? { lastPulledLogId: sourceState.lastPulledLogId }
      : {}),
    ...(sourceState?.lastSeenRemoteVersion !== undefined
      ? { lastSeenRemoteVersion: sourceState.lastSeenRemoteVersion }
      : {}),
  });
}

export async function pushLinkedSourceToCloud(
  input: TursoBookendTarget,
): Promise<boolean> {
  const creds = {
    tursoUrl: input.tursoUrl,
    authToken: input.authToken,
  };
  const state = loadTursoSyncState();
  const sourceState = state.jobs[input.syncKey];
  const pushResult = await pushLocalDbToTurso(input.dbPath, creds, {
    jobId: input.syncKey,
    ...(sourceState?.tableFingerprints
      ? { previousFingerprints: sourceState.tableFingerprints }
      : {}),
    ...(sourceState?.lastPushedLogId !== undefined
      ? { lastPushedLogId: sourceState.lastPushedLogId }
      : {}),
  });
  return pushResult.status === "pushed";
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
}): Promise<boolean> {
  const { getPaprJobsRoot } = await import("../../../core/utils/paprRoot.js");
  const dbPath = `${getPaprJobsRoot()}/${input.jobId}/data/data.db`;
  return pushLinkedSourceToCloud({
    syncKey: input.jobId,
    dbPath,
    tursoUrl: input.tursoUrl,
    authToken: input.authToken,
  });
}
