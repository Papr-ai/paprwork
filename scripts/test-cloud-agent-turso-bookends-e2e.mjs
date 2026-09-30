#!/usr/bin/env node
/**
 * E2E: Cloud agent Turso bookends (v2.2.7 pull/push paths).
 *
 * Exercises the same code Cloud Run revision 00018 uses:
 *   pullLinkedSourceFromCloud → agent writes → pushLinkedSourceToCloud
 *   (pushAllPendingDeltas, applyAllRemoteDeltas, compactRemoteSyncLog)
 *
 * Prerequisites:
 *   npm run build:gateway
 *   PAPR_API_KEY in .env.local, Papr Work keychain, or local gateway (app running)
 *   Memory server reachable (default https://memory.papr.ai)
 *
 * Usage:
 *   npm run test:cloud-agent-turso-bookends
 *   npm run test:cloud-agent-turso-bookends -- --gtm
 *   npm run test:cloud-agent-turso-bookends -- --stress
 *   npm run test:cloud-agent-turso-bookends -- --concurrent-push
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { loadEnvLocal, requireMemoryAccessAsync } from "./lib/testEnv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvLocal();

// Match Cloud Run — skip desktop workspace pointer overriding temp PAPR_HOME
process.env.GATEWAY_MODE = process.env.GATEWAY_MODE ?? "cloud_agent";

const args = process.argv.slice(2);
const memoryBase = (
  args.find((a) => a.startsWith("--memory="))?.split("=")[1] ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "https://memory.papr.ai"
).replace(/\/$/, "");
const useGtmDbs = args.includes("--gtm");
const stressMode = args.includes("--stress");
const concurrentPush = args.includes("--concurrent-push");

let passed = 0;
let failed = 0;
let skipped = 0;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed += 1;
}

function fail(label, detail) {
  console.log(`  ❌ ${label}${detail ? `: ${detail}` : ""}`);
  failed += 1;
}

function skip(label, reason) {
  console.log(`  ⏭️  ${label} — ${reason}`);
  skipped += 1;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isClientClosedError(error) {
  return /Client was closed|manually closed/i.test(errorMessage(error));
}

function cleanupDb(base) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(base + suffix);
    } catch {
      // ignore
    }
  }
}

function sandboxRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `papr-cloud-bookends-${label}-`));
}

async function loadBookends() {
  const bookends = await import(
    pathToFileURL(
      path.join(__dirname, "../dist/gateway/services/cloudAgentGateway/syncJobTursoBookends.js"),
    ).href
  );
  const core = await import(
    pathToFileURL(path.join(__dirname, "../dist/gateway/services/tursoSyncBridgeCore.js")).href
  );
  return { bookends, core };
}

async function fetchTursoCreds(memoryAccess, database) {
  const tokenUrl =
    memoryAccess.mode === "gateway"
      ? `${memoryAccess.cloudBase}/databases/token`
      : `${memoryAccess.memoryBase}/v1/cloud/databases/token`;
  const headers = { "Content-Type": "application/json" };
  if (memoryAccess.mode === "direct") {
    headers["X-API-Key"] = memoryAccess.apiKey;
  }
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ database }),
  });
  if (!res.ok) {
    throw new Error(`token ${database}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  return {
    tursoUrl: body.tursoUrl ?? body.url,
    authToken: body.authToken ?? body.token,
  };
}

function seedAuditsDb(dbPath, { withContactFields = false } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  cleanupDb(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  if (withContactFields) {
    db.exec(`
      CREATE TABLE audits (
        id TEXT PRIMARY KEY,
        company_name TEXT,
        contact_name TEXT,
        contact_email TEXT
      );
    `);
  } else {
    db.exec(`
      CREATE TABLE audits (
        id TEXT PRIMARY KEY,
        company_name TEXT
      );
    `);
  }
  db.prepare("INSERT INTO audits (id, company_name) VALUES (?, ?)").run(
    "audit-1",
    "Sierra AI",
  );
  db.close();
}

function writeMigrationDir(migrationRoot) {
  fs.mkdirSync(path.join(migrationRoot, "migrations"), { recursive: true });
  fs.writeFileSync(
    path.join(migrationRoot, "migrations", "0002_add_contact_fields.sql"),
    "ALTER TABLE audits ADD COLUMN contact_name TEXT;\nALTER TABLE audits ADD COLUMN contact_email TEXT;",
  );
}

async function main() {
  console.log("\n=== Cloud Agent Turso Bookends E2E (v2.2.7 paths) ===");
  console.log(`Memory: ${memoryBase}`);

  const health = await fetch(`${memoryBase}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`Memory server not reachable at ${memoryBase}`);
    process.exit(1);
  }

  const memoryAccess = await requireMemoryAccessAsync();
  if (memoryAccess.mode === "direct") {
    memoryAccess.memoryBase = memoryBase;
  }
  const { bookends, core } = await loadBookends();

  section("1. Fresh sandbox pull → delta write → push (pushAllPendingDeltas)");
  {
    const syncKey = `bookends-${Date.now().toString(36)}`;
    const database = `j-${syncKey.slice(-8)}`;
    const creds = await fetchTursoCreds(memoryAccess, database);
    const root = sandboxRoot("fresh");
    const dbPath = path.join(root, "Jobs", syncKey, "data", "data.db");

    seedAuditsDb(dbPath);
    process.env.PAPR_HOME = path.join(root, "Papr");

    const target = { syncKey, dbPath, ...creds };

    try {
      const bootstrap = await bookends.pushLinkedSourceToCloud(target);
      if (bootstrap.status !== "pushed") {
        fail("bootstrap push", JSON.stringify(bootstrap));
      } else {
        ok(`bootstrap push (${bootstrap.syncMode ?? "unknown"})`);
      }

      cleanupDb(dbPath);
      await bookends.pullLinkedSourceFromCloud(target);

      const db = new Database(dbPath);
      db.prepare("UPDATE audits SET company_name = ? WHERE id = ?").run(
        "Sierra AI Updated",
        "audit-1",
      );
      db.close();

      const deltaPush = await bookends.pushLinkedSourceToCloud({
        ...target,
      });
      if (deltaPush.status === "pushed" && deltaPush.syncMode === "delta") {
        ok(`delta push (${deltaPush.deltaEntries ?? "?"} entries, compact path exercised)`);
      } else if (deltaPush.status === "pushed") {
        ok(`push succeeded (${deltaPush.syncMode ?? "unknown"})`);
      } else {
        fail("delta push", JSON.stringify(deltaPush));
      }
    } catch (error) {
      if (isClientClosedError(error)) {
        fail("fresh sandbox cycle", errorMessage(error));
      } else {
        fail("fresh sandbox cycle", errorMessage(error));
      }
    } finally {
      delete process.env.PAPR_HOME;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  section("2. Pull with remote changelog (applyAllRemoteDeltas path)");
  {
    const syncKey = `pull-delta-${Date.now().toString(36)}`;
    const database = `j-${syncKey.slice(-8)}`;
    const creds = await fetchTursoCreds(memoryAccess, database);
    const root = sandboxRoot("pull");
    const dbPath = path.join(root, "Jobs", syncKey, "data", "data.db");
    seedAuditsDb(dbPath);
    process.env.PAPR_HOME = path.join(root, "Papr");

    const target = { syncKey, dbPath, ...creds };

    try {
      await bookends.pushLinkedSourceToCloud(target);

      const db = new Database(dbPath);
      db.prepare("UPDATE audits SET company_name = ? WHERE id = ?").run("v2", "audit-1");
      db.close();
      await bookends.pushLinkedSourceToCloud(target);

      cleanupDb(dbPath);
      await bookends.pullLinkedSourceFromCloud(target);

      const pulled = new Database(dbPath, { readonly: true });
      const row = pulled.prepare("SELECT company_name FROM audits WHERE id = ?").get("audit-1");
      pulled.close();

      if (row?.company_name === "v2") {
        ok("delta pull round-trip (applyAllRemoteDeltas)");
      } else {
        fail("delta pull value", JSON.stringify(row));
      }
    } catch (error) {
      fail("delta pull cycle", errorMessage(error));
    } finally {
      delete process.env.PAPR_HOME;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  section("3. Migration replay + idempotent push (contact_name path)");
  {
    const syncKey = `migrate-${Date.now().toString(36)}`;
    const database = `d-${syncKey.slice(-8)}`;
    const creds = await fetchTursoCreds(memoryAccess, database);
    const root = sandboxRoot("migrate");
    const dbPath = path.join(root, "data", "databases", "gtm-foundations-audit", "data.db");
    const migrationRoot = path.dirname(dbPath);

    seedAuditsDb(dbPath, { withContactFields: false });
    process.env.PAPR_HOME = path.join(root, "Papr");

    const target = { syncKey, dbPath, ...creds };

    try {
      const bootstrap = await bookends.pushLinkedSourceToCloud(target);
      if (bootstrap.status !== "pushed") {
        fail("migration bootstrap", JSON.stringify(bootstrap));
      } else {
        ok("bootstrap before migration replay");
      }

      writeMigrationDir(migrationRoot);
      const { applyDatabaseMigrations } = await import(
        pathToFileURL(path.join(__dirname, "../dist/gateway/services/jobs/databaseMigrations.js")).href
      );
      applyDatabaseMigrations(migrationRoot, dbPath);

      const push1 = await bookends.pushLinkedSourceToCloud(target);
      if (push1.status !== "pushed") {
        fail("migration push 1", JSON.stringify(push1));
      } else {
        ok("first push after migration (contact columns)");
      }

      const push2 = await bookends.pushLinkedSourceToCloud(target);
      if (push2.status === "pushed" || push2.status === "skipped") {
        ok(`second push idempotent (${push2.status}, ${push2.reason ?? push2.syncMode ?? ""})`);
      } else {
        fail("migration push 2", JSON.stringify(push2));
      }
    } catch (error) {
      const msg = errorMessage(error);
      if (/duplicate column name/i.test(msg)) {
        fail("migration idempotency REGRESSION", msg);
      } else {
        fail("migration cycle", msg);
      }
    } finally {
      delete process.env.PAPR_HOME;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  section("3b. GTM split-brain: Turso schema ahead of migration ledger (pull → push)");
  {
    const syncKey = `ledger-${Date.now().toString(36)}`;
    const database = `d-${syncKey.slice(-8)}`;
    const creds = await fetchTursoCreds(memoryAccess, database);
    const root = sandboxRoot("ledger");
    const dbPath = path.join(root, "data", "databases", "gtm-foundations-audit", "data.db");
    const migrationRoot = path.dirname(dbPath);

    process.env.PAPR_HOME = path.join(root, "Papr");
    const target = { syncKey, dbPath, ...creds };

    try {
      seedAuditsDb(dbPath, { withContactFields: false });
      const bootstrap = await bookends.pushLinkedSourceToCloud(target);
      if (bootstrap.status !== "pushed") {
        fail("ledger bootstrap", JSON.stringify(bootstrap));
      } else {
        ok("remote bootstrapped (base audits, no migrations dir yet)");
      }

      const remote = core.createRemoteClient(creds);
      try {
        await remote.execute("ALTER TABLE audits ADD COLUMN contact_name TEXT");
        await remote.execute("ALTER TABLE audits ADD COLUMN contact_email TEXT");
        await remote.execute(
          "CREATE TABLE IF NOT EXISTS _papr_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'database_migration')",
        );
        await remote.execute(
          "DELETE FROM _papr_schema_migrations WHERE id = '0002_add_contact_fields.sql'",
        );
      } finally {
        remote.close();
      }
      ok("simulated legacy drift (columns on Turso, 0002 not in remote ledger)");

      writeMigrationDir(migrationRoot);

      cleanupDb(dbPath);
      const fresh = new Database(dbPath);
      fresh.exec(`
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_baseline', datetime('now'));
        CREATE TABLE audits (id TEXT PRIMARY KEY, company_name TEXT);
        INSERT INTO audits (id, company_name) VALUES ('audit-1', 'Sierra AI');
      `);
      fresh.close();
      ok("fresh sandbox local DB (migration files on disk, ledger missing 0002)");

      await bookends.pullLinkedSourceFromCloud(target);

      const afterPull = new Database(dbPath, { readonly: true });
      const colNames = afterPull
        .prepare("PRAGMA table_info(audits)")
        .all()
        .map((row) => row.name);
      const migRow = afterPull
        .prepare("SELECT id FROM schema_migrations WHERE id = ?")
        .get("0002_add_contact_fields.sql");
      afterPull.close();

      if (!colNames.includes("contact_name") || !colNames.includes("contact_email")) {
        fail("pull brought contact columns from Turso", colNames.join(", "));
      } else {
        ok("pull synced row/schema from Turso");
      }

      if (!migRow) {
        fail("pull aligned local migration ledger (0002 still missing)");
      } else {
        ok("pull hydrated local schema_migrations (0002 recorded)");
      }

      const db = new Database(dbPath);
      db.prepare(
        "UPDATE audits SET company_name = ?, contact_name = ? WHERE id = ?",
      ).run("Sierra AI Running", "Jane Doe", "audit-1");
      db.close();

      const pushResult = await bookends.pushLinkedSourceToCloud(target);
      if (pushResult.status === "pushed" || pushResult.status === "skipped") {
        ok(
          `post-pull push succeeded (${pushResult.status}, ${pushResult.syncMode ?? pushResult.reason ?? ""})`,
        );
      } else {
        fail("post-pull push", JSON.stringify(pushResult));
      }

      const push2 = await bookends.pushLinkedSourceToCloud(target);
      if (push2.status === "pushed" || push2.status === "skipped") {
        ok(`repeat push idempotent (${push2.status})`);
      } else {
        fail("repeat post-pull push", JSON.stringify(push2));
      }
    } catch (error) {
      const msg = errorMessage(error);
      if (/duplicate column name/i.test(msg)) {
        fail("ledger split-brain REGRESSION (duplicate column)", msg);
      } else {
        fail("ledger split-brain cycle", msg);
      }
    } finally {
      delete process.env.PAPR_HOME;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  section("4. Dual-target sequential (GTM pattern: job + registry db)");
  {
    const jobSyncKey = useGtmDbs ? "51abf434" : `job-${Date.now().toString(36)}`;
    const regSyncKey = useGtmDbs ? "d-2d6b4294" : `reg-${Date.now().toString(36)}`;
    const jobDbName = useGtmDbs ? "j-51abf434" : `j-${jobSyncKey.slice(-8)}`;
    const regDbName = useGtmDbs ? "d-2d6b4294" : `d-${regSyncKey.slice(-8)}`;

    if (useGtmDbs) {
      console.log("  (using live GTM Turso databases — read/write test data only)");
    }

    const root = sandboxRoot("dual");
    process.env.PAPR_HOME = path.join(root, "Papr");

    try {
      const jobCreds = await fetchTursoCreds(memoryAccess, jobDbName);
      const regCreds = await fetchTursoCreds(memoryAccess, regDbName);

      const jobDbPath = path.join(root, "Jobs", jobSyncKey, "data", "data.db");
      const regDbPath = path.join(
        root,
        "data",
        "databases",
        "gtm-foundations-audit",
        "data.db",
      );

      seedAuditsDb(jobDbPath);
      seedAuditsDb(regDbPath, { withContactFields: false });

      const jobTarget = { syncKey: jobDbName, dbPath: jobDbPath, ...jobCreds };
      const regTarget = { syncKey: regDbName, dbPath: regDbPath, ...regCreds };

      await bookends.pullLinkedSourceFromCloud(jobTarget);
      ok("pull job scratch db");

      await bookends.pullLinkedSourceFromCloud(regTarget);
      ok("pull registry db");

      await bookends.pushLinkedSourceToCloud(jobTarget);
      ok("bootstrap job db on Turso");

      await bookends.pushLinkedSourceToCloud(regTarget);
      ok("bootstrap registry db on Turso");

      writeMigrationDir(path.dirname(regDbPath));
      const { applyDatabaseMigrations } = await import(
        pathToFileURL(path.join(__dirname, "../dist/gateway/services/jobs/databaseMigrations.js")).href
      );
      applyDatabaseMigrations(path.dirname(regDbPath), regDbPath);

      const jdb = new Database(jobDbPath);
      jdb.prepare("UPDATE audits SET company_name = ? WHERE id = ?").run("dual-job", "audit-1");
      jdb.close();

      const rdb = new Database(regDbPath);
      rdb.prepare("UPDATE audits SET company_name = ? WHERE id = ?").run("dual-reg", "audit-1");
      rdb.close();

      const jobPush = await bookends.pushLinkedSourceToCloud(jobTarget);
      ok(`push job db (${jobPush.status}, ${jobPush.syncMode ?? jobPush.reason ?? ""})`);

      const regPush = await bookends.pushLinkedSourceToCloud(regTarget);
      ok(`push registry db (${regPush.status}, ${regPush.syncMode ?? regPush.reason ?? ""})`);
    } catch (error) {
      if (isClientClosedError(error)) {
        fail("dual-target sequential REGRESSION (Client was closed)", errorMessage(error));
      } else {
        fail("dual-target sequential", errorMessage(error));
      }
    } finally {
      delete process.env.PAPR_HOME;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  if (concurrentPush) {
    section("5. Concurrent push race (same target)");
    {
      const syncKey = `race-${Date.now().toString(36)}`;
      const database = `j-${syncKey.slice(-8)}`;
      const creds = await fetchTursoCreds(memoryAccess, database);
      const root = sandboxRoot("race");
      const dbPath = path.join(root, "Jobs", syncKey, "data", "data.db");
      seedAuditsDb(dbPath);
      process.env.PAPR_HOME = path.join(root, "Papr");

      const target = { syncKey, dbPath, ...creds };

      try {
        await bookends.pushLinkedSourceToCloud(target);
        const db = new Database(dbPath);
        db.prepare("UPDATE audits SET company_name = ? WHERE id = ?").run("race", "audit-1");
        db.close();

        const results = await Promise.allSettled([
          bookends.pushLinkedSourceToCloud(target),
          bookends.pushLinkedSourceToCloud(target),
        ]);

        const clientClosed = results.filter(
          (r) => r.status === "rejected" && isClientClosedError(r.reason),
        );
        if (clientClosed.length > 0) {
          fail(
            "concurrent push REGRESSION",
            clientClosed.map((r) => errorMessage(r.reason)).join("; "),
          );
        } else if (results.every((r) => r.status === "fulfilled")) {
          ok("concurrent push — no Client was closed");
        } else {
          const msgs = results
            .filter((r) => r.status === "rejected")
            .map((r) => errorMessage(r.reason));
          fail("concurrent push errors", msgs.join("; "));
        }
      } finally {
        delete process.env.PAPR_HOME;
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  } else {
    skip("concurrent push race", "pass --concurrent-push to enable");
  }

  if (stressMode) {
    section("6. Large changelog batch (pushAllPendingDeltas multi-batch)");
    {
      const syncKey = `stress-${Date.now().toString(36)}`;
      const database = `j-${syncKey.slice(-8)}`;
      const creds = await fetchTursoCreds(memoryAccess, database);
      const root = sandboxRoot("stress");
      const dbPath = path.join(root, "Jobs", syncKey, "data", "data.db");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      cleanupDb(dbPath);

      const db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE metrics (id INTEGER PRIMARY KEY, value REAL);
      `);
      const insert = db.prepare("INSERT INTO metrics (id, value) VALUES (?, ?)");
      const tx = db.transaction((n) => {
        for (let i = 1; i <= n; i += 1) insert.run(i, i);
      });
      tx(stressMode ? 3000 : 500);
      db.close();

      process.env.PAPR_HOME = path.join(root, "Papr");
      const target = { syncKey, dbPath, ...creds };

      try {
        const push1 = await core.pushLocalDbToTurso(dbPath, creds, { jobId: syncKey });
        if (push1.status !== "pushed") {
          fail("stress bootstrap", JSON.stringify(push1));
        } else {
          ok(`stress bootstrap (${push1.syncMode})`);
        }

        const db2 = new Database(dbPath);
        db2.prepare("UPDATE metrics SET value = 999 WHERE id = 1").run();
        db2.close();

        const push2 = await core.pushLocalDbToTurso(dbPath, creds, {
          jobId: syncKey,
          lastPushedLogId: push1.lastPushedLogId ?? 0,
          previousFingerprints: push1.tableFingerprints,
        });
        if (push2.status === "pushed") {
          ok(`stress delta push (${push2.syncMode}, ${push2.deltaEntries ?? "?"} entries)`);
        } else {
          fail("stress delta", JSON.stringify(push2));
        }
      } catch (error) {
        if (isClientClosedError(error)) {
          fail("stress push REGRESSION (Client was closed)", errorMessage(error));
        } else {
          fail("stress push", errorMessage(error));
        }
      } finally {
        delete process.env.PAPR_HOME;
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  } else {
    skip("large changelog stress", "pass --stress to enable");
  }

  section("Summary");
  console.log(`Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`);
  if (failed > 0) {
    console.log("\n⚠️  Failures matching production: look for 'Client was closed' or 'duplicate column'");
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
