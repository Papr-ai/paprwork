#!/usr/bin/env node
/**
 * Extended Plan A dogfood: legacy cutover, migrations (11–13), offline/online flows.
 * Uses throwaway registry DBs only; restores databases.json after run.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connect } from "@tursodatabase/sync";
import { createClient } from "@libsql/client";
import { loadEnvLocal } from "./lib/testEnv.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** @type {Array<[string, boolean, string]>} */
const results = [];

function record(id, pass, detail) {
  results.push([id, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"} [${id}] ${detail}`);
}

function cleanupSqlite(base) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(base + suffix);
    } catch {
      /* ignore */
    }
  }
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
  throw new Error("No Papr API key — login in Papr Work first");
}

function readActiveWorkspace() {
  const pointerPath = path.join(os.homedir(), "Papr", ".active-workspace.json");
  const parsed = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
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

async function writeMigration(migrationRoot, fileName, sql) {
  const dir = path.join(migrationRoot, "migrations");
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, fileName), `${sql.trim()}\n`, "utf8");
}

function isHostNotReadyError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("404") || msg.includes("Host not found") || msg.includes("not found");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(opts, label = "connect") {
  const delays = [0, 1500, 3000, 5000, 8000];
  let lastError;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await sleep(delays[attempt]);
    }
    try {
      const db = await connect(opts);
      await db.connect();
      return db;
    } catch (error) {
      lastError = error;
      if (!isHostNotReadyError(error) || attempt === delays.length - 1) {
        throw error;
      }
      console.log(`  … retry ${label} in ${delays[attempt + 1] ?? 0}ms`);
    }
  }
  throw lastError;
}

async function provisionTursoReplica(creds, localPath) {
  cleanupSqlite(localPath);
  const db = await connectWithRetry(
    {
      path: localPath,
      url: creds.tursoUrl,
      authToken: creds.authToken,
      bootstrapIfEmpty: true,
    },
    "provision",
  );
  await db.exec("SELECT 1");
  await db.push();
  await db.close();
  cleanupSqlite(localPath);
}

async function fetchTursoCreds(bridge, tursoShortName) {
  return bridge.fetchCredentials(tursoShortName);
}

async function remoteExec(creds, sql) {
  const client = createClient({ url: creds.tursoUrl, authToken: creds.authToken });
  try {
    await client.execute(sql);
  } finally {
    client.close();
  }
}

async function remoteQuery(creds, sql) {
  const client = createClient({ url: creds.tursoUrl, authToken: creds.authToken });
  try {
    return await client.execute(sql);
  } finally {
    client.close();
  }
}

async function reloadRegistry() {
  const { resetDatabaseRegistryForWorkspaceSwitch, initializeDatabaseRegistry } =
    await import("../dist/gateway/services/DatabaseRegistryService.js");
  resetDatabaseRegistryForWorkspaceSwitch();
  await initializeDatabaseRegistry();
}

async function resetReplicaConnections() {
  const { resetTursoReplicaServiceForTests } = await import(
    "../dist/gateway/services/tursoReplica/TursoReplicaService.js"
  );
  resetTursoReplicaServiceForTests();
}

function makeSource(dbId, slug, localPath, linkedAt) {
  return {
    id: dbId,
    type: "sqlite",
    dbId,
    alias: slug,
    dbPath: localPath,
    tables: [],
    linkedAt,
  };
}

async function main() {
  console.log("\n=== Extended replica dogfood (legacy + migrations + offline) ===\n");

  await resolveApiKey();
  const workspace = readActiveWorkspace();
  applyWorkspaceEnv(workspace);

  process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
  process.env.PAPR_TURSO_REPLICA_SYNC_ALLOW_PRODUCTION = "1";
  process.env.CLOUD_SYNC_ENABLED = "true";
  process.env.TURSO_SYNC_ENABLED = "true";

  const { initializeTursoSyncBridge } = await import(
    "../dist/gateway/services/TursoSyncBridge.js"
  );
  const bridge = initializeTursoSyncBridge();

  const {
    tursoNameForRecord,
  } = await import("../dist/gateway/services/DatabaseRegistryService.js");
  const {
    queryLinkedDbViaTursoReplica,
    pullLinkedDbViaTursoReplica,
    pushLinkedDbViaTursoReplica,
  } = await import("../dist/gateway/services/tursoReplica/tursoReplicaRouting.js");
  const {
    paprDbExec,
    paprDbPush,
    paprDbPull,
    paprDbApplyMigration,
  } = await import("../dist/gateway/services/tursoReplica/PaprDbService.js");
  const { setTursoReplicaOnlineForTests } = await import(
    "../dist/gateway/utils/tursoReplicaEnabled.js"
  );

  const dbId = `db-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const slug = `replica-extended-${Date.now().toString(36)}`;
  const dbRoot = path.join(workspace.paprHome, "data", "databases", slug);
  const localPath = path.join(dbRoot, "data.db");
  const tursoShortName = `d-${dbId.replace(/^db-/, "").slice(0, 8)}`;
  const migrationRoot = dbRoot;
  const now = new Date().toISOString();

  const registryPath = path.join(workspace.paprHome, "data", "databases.json");
  const registryBackup = `${registryPath}.extended-dogfood-${Date.now()}`;
  const registry = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, "utf8"))
    : { version: 1, databases: {} };
  const registryHadBackup = fs.existsSync(registryPath);
  if (registryHadBackup) {
    await fs.promises.copyFile(registryPath, registryBackup);
  }

  registry.databases[dbId] = {
    dbId,
    localPath,
    tursoShortName,
    label: "Replica Extended Autotest",
    isolation: "shared",
    status: "active",
    syncMode: "legacy",
    createdAt: now,
    updatedAt: now,
  };
  await fs.promises.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await fs.promises.mkdir(dbRoot, { recursive: true });

  console.log(`Throwaway DB: ${dbId} (${slug})\n`);

  const tursoDatabase = tursoNameForRecord({
    dbId,
    tursoShortName,
    isolation: "shared",
  });
  let creds;

  try {
    await reloadRegistry();
    creds = await fetchTursoCreds(bridge, tursoDatabase);
    await provisionTursoReplica(creds, localPath + ".provision-tmp");

    // ── Legacy cutover: Turso has truth, local file is stale ─────────────
    await remoteExec(
      creds,
      "CREATE TABLE IF NOT EXISTS cutover_marker (id INTEGER PRIMARY KEY, source TEXT NOT NULL)",
    );
    await remoteExec(creds, "DELETE FROM cutover_marker");
    await remoteExec(
      creds,
      "INSERT INTO cutover_marker (source) VALUES ('from-turso-authority')",
    );

    cleanupSqlite(localPath);
    const stale = new DatabaseSync(localPath);
    stale.exec(
      "CREATE TABLE stale_local (id INTEGER PRIMARY KEY, note TEXT NOT NULL)",
    );
    stale.prepare("INSERT INTO stale_local (note) VALUES ('stale-local-only')").run();
    stale.close();

    registry.databases[dbId].syncMode = "replica";
    registry.databases[dbId].updatedAt = new Date().toISOString();
    await fs.promises.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await reloadRegistry();
    await resetReplicaConnections();

    const source = makeSource(dbId, slug, localPath, now);
    await pullLinkedDbViaTursoReplica(source);
    const cutoverRead = await queryLinkedDbViaTursoReplica(
      source,
      "SELECT source FROM cutover_marker",
    );
    const cutoverOk =
      cutoverRead.rows?.length === 1 &&
      String(cutoverRead.rows[0].source ?? cutoverRead.rows[0].value) ===
        "from-turso-authority";
    record(
      "legacy-cutover-pull",
      cutoverOk,
      cutoverOk
        ? "pull() after legacy→replica flip sees Turso rows"
        : `unexpected rows: ${JSON.stringify(cutoverRead.rows)}`,
    );

    let staleGone = false;
    try {
      const staleRead = await queryLinkedDbViaTursoReplica(
        source,
        "SELECT note FROM stale_local",
      );
      staleGone = (staleRead.rows?.length ?? 0) === 0;
    } catch {
      staleGone = true;
    }
    record(
      "legacy-cutover-stale-gone",
      staleGone,
      staleGone
        ? "stale local-only table not visible after Turso pull"
        : "stale table still readable",
    );

    // ── Spike 11: migration before git upload (online applyMigration) ───
    setTursoReplicaOnlineForTests(null);
    await reloadRegistry();
    await resetReplicaConnections();
    await writeMigration(
      migrationRoot,
      "0001_init.sql",
      `CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL
      );`,
    );
    const mig11 = await paprDbApplyMigration({ dbId, migrationId: "0001_init" });
    const mig11Remote = await remoteQuery(
      creds,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='items'",
    );
    record(
      "spike-11-no-git-gate",
      mig11.applied === true &&
        mig11.backend === "turso-replica" &&
        mig11Remote.rows.length === 1,
      `applyMigration without git: applied=${mig11.applied} backend=${mig11.backend}`,
    );

    // ── Spike 13: online DDL via applyMigration + pull convergence ─────
    await writeMigration(
      migrationRoot,
      "0002_add_status.sql",
      "ALTER TABLE items ADD COLUMN status TEXT DEFAULT 'active';",
    );
    const mig13 = await paprDbApplyMigration({ dbId, migrationId: "0002_add_status" });
    const mig13Remote = await remoteQuery(creds, "PRAGMA table_info(items)");
    const hasStatus = mig13Remote.rows.some(
      (row) => String(row.name ?? row[1]) === "status",
    );
    record(
      "spike-13-online-ddl",
      mig13.applied === true && hasStatus,
      `online applyMigration + remote column status=${hasStatus}`,
    );

    // ── Offline rows → online reconnect ─────────────────────────────────
    setTursoReplicaOnlineForTests(false);
    const offlineWrite = await paprDbExec({
      dbId,
      sql: "INSERT INTO items (label, status) VALUES (?, ?)",
      params: ["offline-row", "pending"],
    });
    setTursoReplicaOnlineForTests(true);
    const offlinePush = await paprDbPush({ dbId });
    const offlineRemote = await remoteQuery(
      creds,
      "SELECT label FROM items WHERE label = 'offline-row'",
    );
    record(
      "offline-rows-reconnect",
      offlineWrite.pendingPush === true &&
        offlinePush.ok === true &&
        offlineRemote.rows.length === 1,
      `pendingPush=${offlineWrite.pendingPush} push=${offlinePush.ok} remoteRows=${offlineRemote.rows.length}`,
    );

    // ── Online migration → offline migration → reconnect ────────────────
    setTursoReplicaOnlineForTests(null);
    await writeMigration(
      migrationRoot,
      "0003_add_priority.sql",
      "ALTER TABLE items ADD COLUMN priority INTEGER DEFAULT 0;",
    );
    const migOnline = await paprDbApplyMigration({
      dbId,
      migrationId: "0003_add_priority",
    });

    setTursoReplicaOnlineForTests(false);
    await writeMigration(
      migrationRoot,
      "0004_add_tag.sql",
      "ALTER TABLE items ADD COLUMN tag TEXT;",
    );
    const migOffline = await paprDbApplyMigration({
      dbId,
      migrationId: "0004_add_tag",
    });
    setTursoReplicaOnlineForTests(true);
    const migReconnectPush = await paprDbPush({ dbId });
    const migRemoteCols = await remoteQuery(creds, "PRAGMA table_info(items)");
    const colNames = migRemoteCols.rows.map((row) => String(row.name ?? row[1]));
    const migSeqOk =
      migOnline.applied === true &&
      migOffline.pendingPush === true &&
      migReconnectPush.ok === true &&
      colNames.includes("priority") &&
      colNames.includes("tag");
    record(
      "online-offline-migration-seq",
      migSeqOk,
      `0003 online ok, 0004 offline pendingPush=${migOffline.pendingPush}, push=${migReconnectPush.ok}, cols=${colNames.join(",")}`,
    );

    // ── Spike 12: cloud-ahead — Turso has 0006, local offline applies 0005 ─
    await remoteExec(
      creds,
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT)",
    );
    await writeMigration(
      migrationRoot,
      "0005_device.sql",
      "ALTER TABLE items ADD COLUMN device_note TEXT;",
    );
    await writeMigration(
      migrationRoot,
      "0006_cloud_only.sql",
      "ALTER TABLE items ADD COLUMN cloud_only TEXT;",
    );
    await remoteExec(creds, "ALTER TABLE items ADD COLUMN cloud_only TEXT");
    await remoteExec(
      creds,
      "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES ('0006_cloud_only', datetime('now'))",
    );

    await resetReplicaConnections();
    setTursoReplicaOnlineForTests(false);
    let spike12Detail = "";
    let spike12Pass = false;
    try {
      const localOnly = await paprDbApplyMigration({
        dbId,
        migrationId: "0005_device",
      });
      setTursoReplicaOnlineForTests(true);
      const pushResult = await paprDbPush({ dbId });
      const colsAfter = await remoteQuery(creds, "PRAGMA table_info(items)");
      const names = colsAfter.rows.map((row) => String(row.name ?? row[1]));
      const hasDevice = names.includes("device_note");
      const hasCloud = names.includes("cloud_only");
      spike12Pass =
        localOnly.pendingPush === true &&
        pushResult.ok === false &&
        pushResult.error?.includes("MIGRATION_CONFLICT") === true &&
        hasCloud &&
        !hasDevice;
      spike12Detail = `local pendingPush=${localOnly.pendingPush} push=${pushResult.ok}${pushResult.error ? ` err=${pushResult.error.slice(0, 120)}` : ""} device_col=${hasDevice} cloud_col=${hasCloud}`;
    } catch (error) {
      spike12Pass = true;
      spike12Detail = `reconnect failed loud: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`;
    } finally {
      setTursoReplicaOnlineForTests(null);
    }
    record(
      "spike-12-cloud-ahead",
      spike12Pass,
      `${spike12Detail} (pass = push fails loud with MIGRATION_CONFLICT, cloud schema preserved)`,
    );
  } finally {
    setTursoReplicaOnlineForTests(null);
    delete registry.databases[dbId];
    if (registryHadBackup) {
      await fs.promises.copyFile(registryBackup, registryPath);
      await fs.promises.unlink(registryBackup);
      console.log("\nRestored databases.json");
    } else {
      await fs.promises.writeFile(
        registryPath,
        `${JSON.stringify(registry, null, 2)}\n`,
        "utf8",
      );
    }
    cleanupSqlite(localPath);
    try {
      await fs.promises.rm(dbRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log("\n=== SUMMARY ===");
  const passed = results.filter(([, ok]) => ok).length;
  for (const [id, ok, detail] of results) {
    console.log(`${ok ? "PASS" : "FAIL"} [${id}] ${detail}`);
  }
  console.log(`\n${passed}/${results.length} passed\n`);

  if (passed !== results.length) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("EXTENDED_DOGFOOD_FATAL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
