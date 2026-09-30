#!/usr/bin/env node
/**
 * Dogfood Plan A registry replica path (one throwaway DB, isolated files).
 * Requires Papr login (keychain) or PAPR_API_KEY. Does not modify production registry entries.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadEnvLocal } from "./lib/testEnv.mjs";
import {
  createThrowawayFixture,
  destroyThrowawayFixture,
  fetchTursoCredentials,
  importDist,
  patchBridgeCredentials,
  provisionTursoReplica,
  reloadRegistry,
  remoteQuery,
  requireReplicaE2eAccess,
  resetReplicaConnections,
  writeMigration,
} from "./lib/replicaE2eHarness.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function log(msg) {
  console.log(msg);
}

async function resolveApiKey() {
  loadEnvLocal(repoRoot);
  if (process.env.PAPR_API_KEY?.trim()) {
    return process.env.PAPR_API_KEY.trim();
  }
  const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");
  const helper = path.join(repoRoot, "scripts", "lib", "read-papr-key-keychain.mjs");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const { stdout } = await execFileAsync(electronBin, [helper], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const key = stdout.trim();
    if (key.startsWith("sk-")) {
      process.env.PAPR_API_KEY = key;
      return key;
    }
  } catch (error) {
    const err = /** @type {{ stdout?: string }} */ (error);
    const key = err.stdout?.trim() ?? "";
    if (key.startsWith("sk-")) {
      process.env.PAPR_API_KEY = key;
      return key;
    }
  }
  throw new Error("No Papr API key in keychain — login in Papr Work first");
}

function readActiveWorkspace() {
  const pointerPath = path.join(os.homedir(), "Papr", ".active-workspace.json");
  const raw = fs.readFileSync(pointerPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.paprHome?.trim()) {
    throw new Error("Missing paprHome in .active-workspace.json");
  }
  return {
    paprHome: path.resolve(parsed.paprHome),
    orgId: parsed.orgId,
    namespaceId: parsed.namespaceId,
  };
}

function applyWorkspaceEnv(workspace) {
  process.env.PAPR_HOME = workspace.paprHome;
  process.env.PAPR_ORG_ID = workspace.orgId;
  process.env.PAPR_NAMESPACE_ID = workspace.namespaceId;
}

async function main() {
  log("\n=== Registry replica dogfood (Plan A) ===\n");

  const access = await requireReplicaE2eAccess();
  const workspace = readActiveWorkspace();
  applyWorkspaceEnv(workspace);

  const { initializeTursoSyncBridge } = await importDist(
    "gateway/services/TursoSyncBridge.js",
  );
  const bridge = initializeTursoSyncBridge();
  patchBridgeCredentials(bridge, access);

  const fixture = await createThrowawayFixture(access, { withApp: false });
  const { dbId, slug, localPath, migrationRoot, now, tursoDatabase } = fixture;
  log(`Created throwaway registry DB: ${dbId} (${slug})`);
  log(`Workspace: ${workspace.paprHome}\n`);

  const creds = await fetchTursoCredentials(access, tursoDatabase);
  await provisionTursoReplica(creds, `${localPath}.dogfood-provision-tmp`);

  const results = [];

  try {
    await reloadRegistry();
    await resetReplicaConnections();

    const { shouldUseTursoReplicaForSource, shouldSuppressLegacyTursoPush, queryLinkedDbViaTursoReplica } =
      await importDist("gateway/services/tursoReplica/tursoReplicaRouting.js");
    const { paprDbExec, paprDbPush, paprDbSyncStatus, paprDbApplyMigration } = await importDist(
      "gateway/services/tursoReplica/PaprDbService.js",
    );

    const source = {
      id: dbId,
      type: "sqlite",
      dbId,
      alias: slug,
      dbPath: localPath,
      tables: [],
      linkedAt: now,
    };

    await writeMigration(
      migrationRoot,
      "0001_replica_dogfood.sql",
      "CREATE TABLE IF NOT EXISTS replica_dogfood (id INTEGER PRIMARY KEY, note TEXT NOT NULL);",
    );

    const routingOk =
      shouldUseTursoReplicaForSource(source) &&
      shouldSuppressLegacyTursoPush({ syncKey: dbId, dbId, dbPath: localPath });
    results.push(["routing", routingOk, routingOk ? "replica + legacy suppressed" : "routing failed"]);

    const migration = await paprDbApplyMigration({
      dbId,
      migrationId: "0001_replica_dogfood",
    });
    const migrationOk = migration.applied === true && migration.backend === "turso-replica";
    results.push([
      "migration",
      migrationOk,
      migrationOk
        ? `applied on ${migration.backend}`
        : JSON.stringify(migration),
    ]);

    const write = await paprDbExec({
      dbId,
      sql: "INSERT INTO replica_dogfood (note) VALUES (?)",
      params: ["registry-replica-dogfood"],
    });
    const writeOk =
      write.backend === "turso-replica" && write.changes === 1;
    results.push([
      "write",
      writeOk,
      writeOk
        ? `turso-replica backend, changes=${write.changes}`
        : JSON.stringify(write),
    ]);

    const push = await paprDbPush({ dbId });
    results.push(["push", push.ok === true, push.ok ? "ok" : push.error ?? "failed"]);

    const remoteRow = await remoteQuery(
      creds,
      "SELECT note FROM replica_dogfood WHERE note = 'registry-replica-dogfood'",
    );
    results.push([
      "cloud-row",
      remoteRow.rows.length === 1,
      remoteRow.rows.length === 1 ? "row on Turso primary" : "row missing on cloud",
    ]);

    const remoteLedger = await remoteQuery(
      creds,
      "SELECT id FROM schema_migrations WHERE id = '0001_replica_dogfood'",
    );
    results.push([
      "cloud-ledger",
      remoteLedger.rows.length === 1,
      `ledgerRows=${remoteLedger.rows.length}`,
    ]);

    const status = await paprDbSyncStatus({ dbId });
    const statusOk = status.syncMode === "replica" && status.online === true;
    results.push([
      "syncStatus",
      statusOk,
      `syncMode=${status.syncMode} online=${status.online} pendingPush=${status.pendingPush}`,
    ]);

    const read = await queryLinkedDbViaTursoReplica(
      source,
      "SELECT note FROM replica_dogfood WHERE note = ?",
      ["registry-replica-dogfood"],
    );
    const readOk = read.rows?.length === 1;
    results.push(["read", readOk, readOk ? "row visible locally" : "read failed"]);
  } finally {
    await resetReplicaConnections();
    await destroyThrowawayFixture(fixture);
    log("\nRestored workspace fixtures");
  }

  log("\n=== RESULTS ===");
  let passed = 0;
  for (const [id, ok, detail] of results) {
    log(`${ok ? "PASS" : "FAIL"} [${id}] ${detail}`);
    if (ok) passed += 1;
  }
  log(`\n${passed}/${results.length} passed\n`);

  if (passed !== results.length) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("DOGFOOD_FATAL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
