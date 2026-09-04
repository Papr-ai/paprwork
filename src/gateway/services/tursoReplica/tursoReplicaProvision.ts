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
import { getTursoReplicaSyncWorkerClient } from "./TursoReplicaSyncWorkerClient.js";
import { ensureReplicaSchemaMigrationsLedger } from "./tursoReplicaSchemaLedger.js";
import {
  removeTursoReplicaLocalFiles,
  removeTursoReplicaSidecarsOnly,
} from "./tursoReplicaFileGuard.js";
import { clearLegacyTursoSyncStateForDbPath } from "../tursoSyncState.js";
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
import { stripLegacySyncPathArtifacts } from "../legacyCdcArtifacts.js";

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

const PROVISION_TIMEOUT_MS = 60_000;

/**
 * Open the replica in the sync worker, verify it answers, and reconcile with Turso.
 * The handle is released afterwards so the caller may touch the files directly.
 */
async function openAndSyncReplicaViaWorker(options: {
  localPath: string;
  tursoUrl: string;
  authToken: string;
  bootstrapIfEmpty: boolean;
  mode: ProvisionTursoReplicaMode;
}): Promise<void> {
  const client = getTursoReplicaSyncWorkerClient();
  const spec = {
    localPath: options.localPath,
    tursoUrl: options.tursoUrl,
    authToken: options.authToken,
    bootstrapIfEmpty: options.bootstrapIfEmpty,
    timeoutMs: PROVISION_TIMEOUT_MS,
  };
  try {
    await client.exec({ ...spec, sql: "SELECT 1" });
    if (!isTursoReplicaOnline()) {
      return;
    }
    // Legacy cutover seeds Turso via libsql batch insert, then replaces the local
    // file with a fresh @tursodatabase/sync replica. push() on that empty replica
    // often fails checkpoint (watermark ahead of WAL). Remote is authoritative — pull only.
    await client.sync(spec, options.mode === "legacy_cutover" ? "pull" : "pullPush");
  } finally {
    await client.close(options.localPath);
  }
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

  await openAndSyncReplicaViaWorker({
    localPath: record.localPath,
    tursoUrl: creds.tursoUrl,
    authToken: creds.authToken,
    bootstrapIfEmpty: true,
    mode,
  });

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
 * Wipes local files — use only when both sides are empty (fresh replica bootstrap).
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
 * Cutover path — attach @tursodatabase/sync to an existing data.db without re-downloading rows.
 * Strips legacy CDC artifacts, clears stale sync state, resets sidecars, pull-only reconcile.
 */
export async function attachTursoReplicaInPlaceForCutover(
  record: DatabaseRecord,
): Promise<void> {
  if (!isCloudSyncEnabled() || !isTursoReplicaSyncFeatureEnabled()) {
    throw new Error("Cloud sync or Plan A rollout disabled — cannot cut over");
  }
  if (!fs.existsSync(record.localPath)) {
    throw new Error(`Local database missing: ${record.localPath}`);
  }

  const stripped = stripLegacySyncPathArtifacts(record.localPath);
  if (stripped.length > 0) {
    console.log(
      `[TursoReplicaProvision] Stripped legacy sync artifacts before in-place attach for ${record.dbId}: ` +
        stripped.join(", "),
    );
  }

  const clearedLegacy = clearLegacyTursoSyncStateForDbPath(record.localPath);
  if (clearedLegacy > 0) {
    console.log(
      `[TursoReplicaProvision] Cleared ${clearedLegacy} legacy Turso sync state ` +
        `entries before in-place attach for ${record.dbId}`,
    );
  }

  removeTursoReplicaSidecarsOnly(record.localPath);

  const bridge = getTursoSyncBridge();
  if (!bridge) {
    throw new Error("Turso sync bridge unavailable — cannot attach replica database");
  }

  const tursoDatabase = tursoNameForRecord(record);
  const creds = await bridge.fetchCredentials(tursoDatabase);

  await openAndSyncReplicaViaWorker({
    localPath: record.localPath,
    tursoUrl: creds.tursoUrl,
    authToken: creds.authToken,
    bootstrapIfEmpty: false,
    mode: "legacy_cutover",
  });

  await ensureReplicaSchemaMigrationsLedger(recordAsDataSource(record));
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

  const stripped = stripLegacySyncPathArtifacts(record.localPath);
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
