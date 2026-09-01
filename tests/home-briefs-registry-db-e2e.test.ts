/**
 * End-to-end: Home briefs registry database provisioning + legacy backfill.
 *
 * Runs against an isolated scratch workspace (never the developer's real
 * ~/Papr). Covers the three things that broke in production:
 *   1. the briefs DB must be a REGISTRY db (data/databases/{slug}/data.db),
 *      not the job's scratch data/data.db
 *   2. the bundled migration must apply cleanly and record a ledger id that
 *      matches the file name (the 0001_init vs 0001_create_briefs mismatch
 *      wedged replica cutover for existing users)
 *   3. existing users' rows must migrate out of the legacy job DB without
 *      ever overwriting newer rows
 */

import Database from "better-sqlite3";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import { DEFAULT_HOME_BRIEFS_DB_SLUG } from "../src/gateway/services/defaultHomeBundle.js";

const BUNDLE_DIR = path.join(
  process.cwd(),
  "src/resources/default-apps/home-dashboard",
);
const APP_ID = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
const JOB_ID = "6953796f-b12d-4397-bc80-78bc43911fce";

describe("Home briefs registry DB (e2e, scratch workspace)", () => {
  const ws = useIsolatedPaprWorkspace("home-briefs-e2e");

  let legacyJobDbPath: string;
  let registryDbPath: string;
  let originalCloudSync: string | undefined;

  beforeEach(async () => {
    // Offline scratch run: isCloudSyncEnabled() defaults to TRUE, so register()
    // would try to provision a real Turso replica and fail on PAPR_API_KEY.
    // Local provisioning + migrations + backfill are what we're verifying here.
    originalCloudSync = process.env.CLOUD_SYNC_ENABLED;
    process.env.CLOUD_SYNC_ENABLED = "false";
  });

  afterEach(() => {
    if (originalCloudSync === undefined) {
      delete process.env.CLOUD_SYNC_ENABLED;
    } else {
      process.env.CLOUD_SYNC_ENABLED = originalCloudSync;
    }
  });

  beforeEach(async () => {
    // Simulate an existing user: a legacy job DB holding real briefs.
    legacyJobDbPath = path.join(ws.paprHome, "Jobs", JOB_ID, "data", "data.db");
    await fs.mkdir(path.dirname(legacyJobDbPath), { recursive: true });

    const legacy = new Database(legacyJobDbPath);
    legacy.exec(
      "CREATE TABLE briefs (date TEXT PRIMARY KEY, brief_json TEXT NOT NULL, created_at TEXT)",
    );
    const insert = legacy.prepare(
      "INSERT INTO briefs (date, brief_json, created_at) VALUES (?, ?, datetime('now'))",
    );
    insert.run("2026-08-30", '{"sections":[{"type":"priorities"}],"v":"legacy"}');
    insert.run("2026-08-31", '{"sections":[{"type":"alerts"}],"v":"legacy"}');
    legacy.close();

    registryDbPath = path.join(
      ws.paprHome,
      "data",
      "databases",
      DEFAULT_HOME_BRIEFS_DB_SLUG,
      "data.db",
    );
  });

  /** Mirrors provisionHomeBriefsRegistryDb() using the real production helpers. */
  async function provisionRegistryDb(): Promise<string> {
    const dbDir = path.dirname(registryDbPath);
    const migrationsDir = path.join(dbDir, "migrations");
    await fs.mkdir(migrationsDir, { recursive: true });

    const bundled = path.join(BUNDLE_DIR, "db-migrations");
    for (const file of await fs.readdir(bundled)) {
      const target = path.join(migrationsDir, file);
      if (!existsSync(target)) {
        await fs.copyFile(path.join(bundled, file), target);
      }
    }

    const { ensureRegistryDatabase, applyRegistryDatabaseMigrations } =
      await import("../src/gateway/services/jobs/databaseMigrations.js");
    const { shouldDeferRegistrySqliteFileForReplica } = await import(
      "../src/gateway/utils/tursoReplicaEnabled.js"
    );
    await ensureRegistryDatabase(registryDbPath, {
      deferSqliteFile: shouldDeferRegistrySqliteFileForReplica(),
    });

    const { initializeDatabaseRegistry } = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
    const registry = await initializeDatabaseRegistry();
    const record = await registry.register({
      localPath: registryDbPath,
      label: "Home Daily Briefs",
      schemaOwnerAppId: APP_ID,
      // deliberately no ownerJobId — that would force a j-* Turso name
    });

    await applyRegistryDatabaseMigrations(registryDbPath);
    return record.dbId;
  }

  it("provisions a registry DB with a d-* Turso name, not a job DB", async () => {
    const dbId = await provisionRegistryDb();

    const { initializeDatabaseRegistry, registrySlugFromLocalPath } =
      await import("../src/gateway/services/DatabaseRegistryService.js");
    const registry = await initializeDatabaseRegistry();
    const record = registry.getByPath(registryDbPath);

    expect(record).toBeDefined();
    expect(record?.dbId).toBe(dbId);
    // The path must be recognised as a registry slug — a job path returns null.
    expect(registrySlugFromLocalPath(record!.localPath)).toBe(
      DEFAULT_HOME_BRIEFS_DB_SLUG,
    );
    // d-* (registry) not j-* (job-owned).
    expect(record?.tursoShortName).toMatch(/^d-[a-f0-9]{8}$/);
    expect(record?.ownerJobId).toBeUndefined();
  });

  it("applies the bundled migration and records a matching ledger id", async () => {
    await provisionRegistryDb();

    const db = new Database(registryDbPath, { readonly: true });
    try {
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='briefs'",
        )
        .get();
      expect(table).toBeDefined();

      const applied = db
        .prepare("SELECT id FROM schema_migrations")
        .all() as Array<{ id: string }>;
      const ids = applied.map((r) => r.id);

      // The ledger id must correspond to a file that actually ships. The
      // production wedge was a ledger entry ("0001_init") with no matching
      // file ("0001_create_briefs.sql") — cutover then threw
      // "Migration SQL missing for 0001_init".
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const fileName = id.endsWith(".sql") ? id : `${id}.sql`;
        expect(
          existsSync(
            path.join(path.dirname(registryDbPath), "migrations", fileName),
          ),
        ).toBe(true);
      }

      // briefs must have a PRIMARY KEY for replica row versioning.
      const cols = db.prepare("PRAGMA table_info(briefs)").all() as Array<{
        name: string;
        pk: number;
      }>;
      expect(cols.find((c) => c.name === "date")?.pk).toBe(1);
    } finally {
      db.close();
    }
  });

  it("backfills legacy rows without overwriting newer ones, and is idempotent", async () => {
    await provisionRegistryDb();

    // A newer brief for the same date already exists in the registry DB.
    const seed = new Database(registryDbPath);
    seed
      .prepare(
        "INSERT INTO briefs (date, brief_json, created_at) VALUES (?, ?, datetime('now'))",
      )
      .run("2026-08-31", '{"sections":[{"type":"alerts"}],"v":"NEW"}');
    seed.close();

    const backfill = () => {
      // Plain path + readonly:true — better-sqlite3 does not parse file: URIs.
      const legacy = new Database(legacyJobDbPath, { readonly: true });
      const rows = legacy
        .prepare("SELECT date, brief_json FROM briefs WHERE brief_json IS NOT NULL")
        .all() as Array<{ date: string; brief_json: string }>;
      legacy.close();

      const target = new Database(registryDbPath);
      try {
        const stmt = target.prepare(
          "INSERT OR IGNORE INTO briefs (date, brief_json, created_at) VALUES (?, ?, datetime('now'))",
        );
        let count = 0;
        for (const row of rows) {
          count += stmt.run(row.date, row.brief_json).changes;
        }
        return count;
      } finally {
        target.close();
      }
    };

    expect(backfill()).toBe(1); // only 08-30 is new
    expect(backfill()).toBe(0); // re-run is a no-op

    const verify = new Database(registryDbPath, { readonly: true });
    try {
      const rows = verify
        .prepare("SELECT date, brief_json FROM briefs ORDER BY date")
        .all() as Array<{ date: string; brief_json: string }>;
      expect(rows.map((r) => r.date)).toEqual(["2026-08-30", "2026-08-31"]);
      // The newer row survived — INSERT OR IGNORE never clobbers.
      expect(rows[1].brief_json).toContain('"v":"NEW"');
      expect(rows[0].brief_json).toContain('"v":"legacy"');
    } finally {
      verify.close();
    }

    // Legacy DB is left intact as a safety net.
    expect(existsSync(legacyJobDbPath)).toBe(true);
  });
});
