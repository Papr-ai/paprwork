#!/usr/bin/env node
/**
 * Reseed a Plan A replica DB from Turso primary (repair hybrid/contaminated local files).
 *
 * Usage:
 *   npm run build:gateway
 *   node scripts/reseed-replica-db.mjs db-6ca6fa3c
 *
 * Stop the gateway first if it holds open replica connections on this db.
 */

import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  applyReplicaE2eEnv,
  fetchTursoCredentials,
  patchBridgeCredentials,
  readActiveWorkspace,
  requireReplicaE2eAccess,
} from "./lib/replicaE2eHarness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const dist = path.join(repoRoot, "dist/gateway");

async function importDist(rel) {
  return import(pathToFileURL(path.join(dist, rel)).href);
}

async function main() {
  const dbId = process.argv[2]?.trim();
  if (!dbId) {
    console.error("Usage: node scripts/reseed-replica-db.mjs <dbId>");
    process.exitCode = 1;
    return;
  }

  const workspace = readActiveWorkspace();
  applyReplicaE2eEnv(workspace);
  const access = await requireReplicaE2eAccess();

  const { getDatabaseRegistryService } = await importDist(
    "services/DatabaseRegistryService.js",
  );
  const registry = getDatabaseRegistryService();
  await registry.initialize();

  const record = registry.getById(dbId);
  if (!record) {
    throw new Error(`Database ${dbId} not found in registry`);
  }
  if (record.syncMode !== "replica") {
    throw new Error(`${dbId} is not syncMode=replica (got ${record.syncMode ?? "legacy"})`);
  }

  console.log("[reseed] dbId:", dbId);
  console.log("[reseed] localPath:", record.localPath);
  console.log("[reseed] turso:", record.tursoShortName);

  const { initializeTursoSyncBridge } = await importDist(
    "services/TursoSyncBridge.js",
  );
  const bridge = initializeTursoSyncBridge();
  patchBridgeCredentials(bridge, access);

  const { reseedTursoReplicaFromRemote } = await importDist(
    "services/tursoReplica/tursoReplicaProvision.js",
  );

  console.log("[reseed] Closing connections and wiping local replica files...");
  await reseedTursoReplicaFromRemote(record);

  const { queryLinkedDbViaTursoReplica } = await importDist(
    "services/tursoReplica/tursoReplicaRouting.js",
  );
  const source = {
    id: dbId,
    type: "sqlite",
    dbId,
    alias: record.label ?? dbId,
    dbPath: record.localPath,
    tables: [],
    linkedAt: record.createdAt,
  };

  const probe = await queryLinkedDbViaTursoReplica(
    source,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    [],
  );
  const tables = probe.rows.map((row) => String(row.name ?? row[0] ?? ""));
  console.log("[reseed] Tables after reseed:", tables.join(", ") || "(none)");

  const hasLegacyCdc = tables.some(
    (t) => t === "_papr_schema_migrations" || t.startsWith("_papr_sync"),
  );
  if (hasLegacyCdc) {
    console.warn(
      "[reseed] WARNING: legacy CDC tables still present — file may still be contaminated",
    );
    process.exitCode = 1;
  } else {
    console.log("[reseed] OK — replica file is clean (no legacy CDC tables)");
  }
}

main().catch((error) => {
  console.error("[reseed] fatal:", error);
  process.exitCode = 1;
});
