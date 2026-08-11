/**
 * Shared Turso push prep + verify for desktop bridge and cloud sandbox bookends.
 */

import fs from "fs";
import {
  createRemoteClient,
  filterSyncableTables,
  listUserTables,
  openWritableLocalJobDb,
  pushLocalDbToTurso,
  type PushResult,
  type TursoCredentials,
} from "./tursoSyncBridgeCore.js";
import {
  ensureRemoteTablesFromLocal,
  localRemoteSchemaDriftTables,
  prepareRemoteTableForSync,
  remoteNeedsBootstrap,
} from "./tursoDeltaSync.js";
import {
  applyPendingDatabaseMigrationsToTurso,
  resolveMigrationRootFromDbPath,
} from "./jobs/jobMigrationTursoSync.js";
import { localDbHasSyncableData } from "./tursoSyncState.js";

export interface LinkedSourcePushState {
  tableFingerprints?: Record<string, string>;
  lastPushedLogId?: number;
}

export interface LinkedSourcePushOptions {
  syncKey: string;
  dbPath: string;
  credentials: TursoCredentials;
  state?: LinkedSourcePushState;
  force?: boolean;
}

/** Create missing remote tables + replay pending migrations (desktop pushJob parity). */
export async function prepareRemoteForLinkedSourcePush(
  dbPath: string,
  credentials: TursoCredentials,
  syncKey: string,
): Promise<void> {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) {
    return;
  }

  const migrationRoot = resolveMigrationRootFromDbPath(dbPath);
  const prepRemote = createRemoteClient(credentials);
  const prepLocal = openWritableLocalJobDb(dbPath);
  try {
    const localTables = filterSyncableTables(listUserTables(prepLocal));
    const createdOnRemote = await ensureRemoteTablesFromLocal(
      prepRemote,
      prepLocal,
      localTables,
    );
    if (createdOnRemote.length > 0) {
      console.warn(
        `[TursoPush] ${createdOnRemote.length} local table(s) were missing on remote for ${syncKey}: ` +
          `${createdOnRemote.join(", ")} — created from local schema before migrations`,
      );
    }

    if (migrationRoot) {
      const appliedMigrations = await applyPendingDatabaseMigrationsToTurso(
        prepRemote,
        dbPath,
        migrationRoot,
      );
      if (appliedMigrations.length > 0) {
        console.log(
          `[TursoPush] Applied database migrations on Turso for ${syncKey}: ${appliedMigrations.join(", ")}`,
        );
      }
    }
  } finally {
    prepLocal.close();
    prepRemote.close();
  }
}

async function retryPushAfterSchemaDrift(
  input: LinkedSourcePushOptions,
  result: PushResult,
): Promise<PushResult> {
  if (result.status !== "pushed" || !fs.existsSync(input.dbPath)) {
    return result;
  }

  const verifyRemote = createRemoteClient(input.credentials);
  const localDb = openWritableLocalJobDb(input.dbPath);
  try {
    const localTables = filterSyncableTables(listUserTables(localDb));
    const drifted = await localRemoteSchemaDriftTables(
      verifyRemote,
      localDb,
      localTables,
    );
    if (drifted.length === 0) {
      return result;
    }

    console.warn(
      `[TursoPush] Remote schema drift for ${input.syncKey} on ${drifted.join(", ")} — applying incremental migration`,
    );
    for (const tableName of drifted) {
      await prepareRemoteTableForSync(verifyRemote, localDb, tableName);
    }
    return pushLocalDbToTurso(input.dbPath, input.credentials, {
      jobId: input.syncKey,
      previousFingerprints: input.state?.tableFingerprints,
      lastPushedLogId: input.state?.lastPushedLogId,
    });
  } finally {
    localDb.close();
    verifyRemote.close();
  }
}

/** Push with desktop parity: prep remote schema, delta-first push, bootstrap verify, drift retry. */
export async function pushLinkedSourceWithDesktopParity(
  input: LinkedSourcePushOptions,
): Promise<PushResult> {
  await prepareRemoteForLinkedSourcePush(
    input.dbPath,
    input.credentials,
    input.syncKey,
  );

  const repairBootstrap = input.force === true;
  let pushResult = await pushLocalDbToTurso(input.dbPath, input.credentials, {
    jobId: input.syncKey,
    previousFingerprints: repairBootstrap
      ? undefined
      : input.state?.tableFingerprints,
    lastPushedLogId: repairBootstrap ? 0 : input.state?.lastPushedLogId,
    ...(repairBootstrap ? { force: true } : {}),
  });

  if (localDbHasSyncableData(input.dbPath)) {
    const verifyRemote = createRemoteClient(input.credentials);
    try {
      const stillEmpty = await remoteNeedsBootstrap(verifyRemote);
      if (stillEmpty) {
        console.warn(
          `[TursoPush] Remote empty after push for ${input.syncKey} — forcing bootstrap`,
        );
        pushResult = await pushLocalDbToTurso(input.dbPath, input.credentials, {
          jobId: input.syncKey,
          force: true,
          previousFingerprints: undefined,
          lastPushedLogId: 0,
        });
      } else {
        pushResult = await retryPushAfterSchemaDrift(input, pushResult);
      }
    } finally {
      verifyRemote.close();
    }
  }

  return pushResult;
}
