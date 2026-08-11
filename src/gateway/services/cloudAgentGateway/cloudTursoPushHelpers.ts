import type { PushResult } from "../tursoSyncBridgeCore.js";
import { notifyCloudDbChanged } from "../cloudSync/notifyCloudDbChanged.js";
import { tursoShortNameForChangeInput } from "../tursoDatabaseNaming.js";
import { bumpSyncIndexForShortName } from "../tursoSyncIndex.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import { localDbHasSyncableData } from "../tursoSyncState.js";
import type { TursoBookendTarget } from "./syncJobTursoBookends.js";

/** Push outcomes that are OK for cloud agent bookends (no data to sync). */
export function isSkippedEmptyTursoTarget(result: PushResult): boolean {
  return (
    result.status === "skipped" &&
    (result.reason === "all_tables_unchanged" ||
      result.reason === "local_db_empty" ||
      result.reason === "local_db_missing" ||
      result.reason === "no_syncable_tables")
  );
}

/** True when the sandbox SQLite file has user tables with rows worth pushing. */
export function tursoTargetHasLocalData(dbPath: string): boolean {
  return localDbHasSyncableData(dbPath);
}

export interface TursoPushOutcome {
  ok: boolean;
  failures: string[];
  /** Keep sandbox when a DB that had local data failed to push (recovery). */
  retainSandbox: boolean;
}

export async function notifyCloudDbChangedForTarget(
  target: TursoBookendTarget,
  result: PushResult,
): Promise<void> {
  if (result.status !== "pushed") {
    return;
  }

  const bridge = getTursoSyncBridge();
  const shortName = tursoShortNameForChangeInput(target);
  if (bridge?.enabled && shortName) {
    await bumpSyncIndexForShortName(
      (databaseName) => bridge.fetchCredentials(databaseName),
      shortName,
    );
  }

  await notifyCloudDbChanged({
    ...(target.jobId ? { jobId: target.jobId } : {}),
    ...(target.dbId ? { dbId: target.dbId } : {}),
    tables: result.tables,
  });
}
