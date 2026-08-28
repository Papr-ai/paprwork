/**
 * Provision a clean Turso Sync replica file for new registry databases.
 * Avoids better-sqlite3 init (legacy CDC tables) before Plan A owns the file.
 */

import * as fs from "fs";
import * as path from "path";
import { createClient } from "@libsql/client";
import type { AppDataSource } from "../appDataSources.js";
import {
  tursoNameForRecord,
  type DatabaseRecord,
} from "../DatabaseRegistryService.js";
import { getTursoSyncBridge } from "../TursoSyncBridge.js";
import { isCloudSyncEnabled } from "../../utils/cloudSyncEnabled.js";
import {
  isTursoReplicaOnline,
  isTursoReplicaSyncFeatureEnabled,
} from "../../utils/tursoReplicaEnabled.js";
import { connectTursoReplica } from "./tursoReplicaConnect.js";
import { ensureReplicaSchemaMigrationsLedger } from "./tursoReplicaSchemaLedger.js";
import { removeTursoReplicaLocalFiles } from "./tursoReplicaFileGuard.js";
import {
  bumpRemoteSyncVersion,
  ensureLocalDbChangeLogReady,
  filterSyncableTables,
  listUserTables,
  openWritableLocalJobDb,
  readLocalTable,
} from "../tursoSyncBridgeCore.js";
import { prepareRemoteTableForSync } from "../tursoTablePrep.js";
import { batchInsertLocalTableRows } from "../tursoBulkInsert.js";
import { stripLegacyCdcArtifacts } from "../legacyCdcArtifacts.js";

function recordAsDataSource(record: DatabaseRecord): AppDataSource {
  return {
    id: record.dbId,
    type: "sqlite",
    alias: record.dbId,
    dbId: record.dbId,
    dbPath: record.localPath,
    tables: [],
    linkedAt: record.createdAt,
  };
}

type ProvisionTursoReplicaMode = "new" | "legacy_cutover";

async function syncReplicaAfterConnect(
  db: Awaited<ReturnType<typeof connectTursoReplica>>,
  mode: ProvisionTursoReplicaMode,
): Promise<void> {
  await db.exec("SELECT 1");
  if (!isTursoReplicaOnline()) {
    return;
  }

  await db.pull();

  // Legacy cutover seeds Turso via libsql batch insert, then replaces the local
  // file with a fresh @tursodatabase/sync replica. push() on that empty replica
  // often fails checkpoint (watermark ahead of WAL). Remote is authoritative — pull only.
  if (mode === "legacy_cutover") {
    return;
  }

  await db.push();
}

async function provisionTursoReplicaCore(
  record: DatabaseRecord,
  mode: ProvisionTursoReplicaMode = "new",
): Promise<void> {
  const bridge = getTursoSyncBridge();
  if (!bridge) {
    throw new Error("Turso sync bridge unavailable — cannot provision replica database");
  }

  const tursoDatabase = tursoNameForRecord(record);
  const creds = await bridge.fetchCredentials(tursoDatabase);

  await fs.promises.mkdir(path.dirname(record.localPath), { recursive: true });
  removeTursoReplicaLocalFiles(record.localPath);

  const db = await connectTursoReplica({
    localPath: record.localPath,
    tursoUrl: creds.tursoUrl,
    authToken: creds.authToken,
    bootstrapIfEmpty: true,
  });

  try {
    await syncReplicaAfterConnect(db, mode);
  } finally {
    await db.close();
  }

  const source = recordAsDataSource(record);
  await ensureReplicaSchemaMigrationsLedger(source);
}

/** Bootstrap local replica file via @tursodatabase/sync (no better-sqlite3). */
export async function provisionTursoReplicaForRecord(
  record: DatabaseRecord,
): Promise<void> {
  if (record.syncMode !== "replica") {
    return;
  }
  if (!isCloudSyncEnabled() || !isTursoReplicaSyncFeatureEnabled()) {
    return;
  }

  await provisionTursoReplicaCore(record);
}

/**
 * Cutover path — provision while syncMode may still be legacy.
 * Caller must mark syncMode=replica only after this succeeds.
 */
export async function provisionTursoReplicaForCutover(
  record: DatabaseRecord,
): Promise<void> {
  if (!isCloudSyncEnabled() || !isTursoReplicaSyncFeatureEnabled()) {
    throw new Error("Cloud sync or Plan A rollout disabled — cannot cut over");
  }

  await provisionTursoReplicaCore(record, "legacy_cutover");
}

/**
 * Final legacy → Turso primary push before cutover (bucket B / dirty C).
 * Bootstraps a full local table snapshot to Turso (CDC/workspace log is not enough).
 */
export async function pushLocalLegacyFileToTursoPrimary(
  record: DatabaseRecord,
): Promise<void> {
  if (!isCloudSyncEnabled() || !isTursoReplicaSyncFeatureEnabled()) {
    throw new Error("Cloud sync or Plan A rollout disabled — cannot push before cutover");
  }
  if (!fs.existsSync(record.localPath)) {
    throw new Error(`Local database missing: ${record.localPath}`);
  }

  const stripped = stripLegacyCdcArtifacts(record.localPath);
  if (stripped.length > 0) {
    console.log(
      `[TursoReplicaProvision] Stripped legacy CDC artifacts before Turso push for ${record.dbId}: ` +
        stripped.join(", "),
    );
  }

  if (!isTursoReplicaOnline()) {
    return;
  }

  const bridge = getTursoSyncBridge();
  if (!bridge) {
    throw new Error("Turso sync bridge unavailable — cannot push before cutover");
  }

  const tursoDatabase = tursoNameForRecord(record);
  const creds = await bridge.fetchCredentials(tursoDatabase);

  ensureLocalDbChangeLogReady(record.localPath);
  const localDb = openWritableLocalJobDb(record.localPath);
  const remote = createClient({ url: creds.tursoUrl, authToken: creds.authToken });

  try {
    const tables = filterSyncableTables(listUserTables(localDb));
    for (const tableName of tables) {
      const columns = await prepareRemoteTableForSync(remote, localDb, tableName);
      if (columns.length === 0) {
        continue;
      }
      const table = readLocalTable(localDb, tableName);
      await batchInsertLocalTableRows(
        remote,
        tableName,
        columns,
        table.rows,
        "upsert",
      );
    }
    await bumpRemoteSyncVersion(remote);
  } finally {
    localDb.close();
    remote.close();
  }
}

/** Drop local replica files and re-pull from Turso primary (repair hybrid/contaminated files). */
export async function reseedTursoReplicaFromRemote(
  record: DatabaseRecord,
): Promise<void> {
  if (record.syncMode !== "replica") {
    throw new Error(`Database ${record.dbId} is not syncMode=replica`);
  }

  const { getTursoReplicaService } = await import("./TursoReplicaService.js");
  const replica = getTursoReplicaService();
  await replica.close(record.localPath);
  removeTursoReplicaLocalFiles(record.localPath);
  await provisionTursoReplicaForRecord(record);
}
