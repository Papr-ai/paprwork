/**
 * Items 2-4: one storage decision for new databases, the OS/CPU engine table,
 * and the cloud-direct backend (primary over HTTP, no local file).
 *
 * The Turso primary is stood in for by a local libsql `file:` database via
 * setCloudDirectClientFactoryForTests — same client, same SQL, same
 * transaction semantics as the remote.
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

describe("engine availability table", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("maps only the OS/CPU pairs upstream ships", async () => {
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.tursoSyncNativePackageFor("darwin", "arm64")).toBe(
      "@tursodatabase/sync-darwin-arm64",
    );
    expect(mod.tursoSyncNativePackageFor("win32", "x64")).toBe(
      "@tursodatabase/sync-win32-x64-msvc",
    );
    expect(mod.tursoSyncNativePackageFor("linux", "x64")).not.toBeNull();
    // No upstream build → cloud-direct
    expect(mod.tursoSyncNativePackageFor("darwin", "x64")).toBeNull();
    expect(mod.tursoSyncNativePackageFor("win32", "arm64")).toBeNull();
  });

  it("PAPR_TURSO_REPLICA_NATIVE overrides detection both ways", async () => {
    process.env.PAPR_TURSO_REPLICA_NATIVE = "0";
    let mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.isTursoReplicaNativeAvailable()).toBe(false);
    process.env.PAPR_TURSO_REPLICA_NATIVE = "1";
    vi.resetModules();
    mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.isTursoReplicaNativeAvailable()).toBe(true);
  });
});

describe("chooseSyncModeForNewDatabase — the one decision", () => {
  beforeEach(() => {
    process.env.CLOUD_SYNC_ENABLED = "true";
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("engine available → replica", async () => {
    process.env.PAPR_TURSO_REPLICA_NATIVE = "1";
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.chooseSyncModeForNewDatabase()).toBe("replica");
  });

  it("no engine (Intel Mac / Windows ARM) → cloud-direct", async () => {
    process.env.PAPR_TURSO_REPLICA_NATIVE = "0";
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.chooseSyncModeForNewDatabase()).toBe("cloud-direct");
  });

  it("no engine but a populated local file (promotion/bundle) stays local", async () => {
    process.env.PAPR_TURSO_REPLICA_NATIVE = "0";
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(
      mod.chooseSyncModeForNewDatabase({ hasExistingLocalData: true }),
    ).toBeUndefined();
  });

  it("cloud sync off → plain local", async () => {
    process.env.CLOUD_SYNC_ENABLED = "false";
    process.env.PAPR_TURSO_REPLICA_NATIVE = "1";
    const mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(mod.chooseSyncModeForNewDatabase()).toBeUndefined();
  });

  it("install: fork is a new DB; team shared keeps publisher mode unless no engine", async () => {
    process.env.PAPR_TURSO_REPLICA_NATIVE = "1";
    let mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(
      mod.syncModeForInstalledDatabase({ installDbPolicy: "fork_empty" }),
    ).toBe("replica");
    expect(
      mod.syncModeForInstalledDatabase({
        installDbPolicy: "shared_primary",
        publisherSyncMode: "replica",
      }),
    ).toBe("replica");

    process.env.PAPR_TURSO_REPLICA_NATIVE = "0";
    vi.resetModules();
    mod = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    expect(
      mod.syncModeForInstalledDatabase({ installDbPolicy: "fork_empty" }),
    ).toBe("cloud-direct");
    expect(
      mod.syncModeForInstalledDatabase({
        installDbPolicy: "shared_primary",
        publisherSyncMode: "replica",
      }),
    ).toBe("cloud-direct");
  });
});

describe("cloud-direct backend (primary stand-in: local libsql file)", () => {
  let tmp: string;
  const dbId = "db-clouddirect-test";
  const localPath = () => path.join(tmp, "data", "databases", "outreach", "data.db");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-cloud-direct-"));
    const record = {
      dbId,
      localPath: localPath(),
      tursoShortName: "d-test",
      label: "outreach",
      isolation: "shared",
      status: "active",
      syncMode: "cloud-direct",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.doMock("../src/gateway/services/DatabaseRegistryService.js", () => ({
      getDatabaseRegistryService: () => ({
        getById: (id: string) => (id === dbId ? record : undefined),
        getByPath: (p: string) =>
          path.normalize(p) === path.normalize(record.localPath) ? record : undefined,
      }),
      resolveTursoDatabaseNameForSource: () => "d-test",
      tursoNameForRecord: () => "d-test",
    }));
  });

  afterEach(async () => {
    const mod = await import("../src/gateway/services/cloudDirect/cloudDirectDb.js");
    mod.setCloudDirectClientFactoryForTests(null);
    vi.doUnmock("../src/gateway/services/DatabaseRegistryService.js");
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function load() {
    const mod = await import("../src/gateway/services/cloudDirect/cloudDirectDb.js");
    const primaryFile = path.join(tmp, "primary.db");
    mod.setCloudDirectClientFactoryForTests(async () =>
      createClient({ url: `file:${primaryFile}` }),
    );
    return mod;
  }

  const source = () => ({
    id: dbId,
    type: "sqlite" as const,
    alias: "outreach",
    dbId,
    dbPath: localPath(),
    tables: [],
    linkedAt: new Date().toISOString(),
  });

  it("recognises the source and never creates a local file", async () => {
    const mod = await load();
    expect(mod.isCloudDirectSource(source())).toBe(true);
    await mod.cloudDirectExec(source(), "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
    await mod.cloudDirectWrite(source(), "INSERT INTO t (v) VALUES (?)", ["a"]);
    const q = await mod.cloudDirectQuery(source(), "SELECT v FROM t");
    expect(q.rows).toEqual([{ v: "a" }]);
    expect(fs.existsSync(localPath())).toBe(false);
  });

  it("write batch is all-or-nothing", async () => {
    const mod = await load();
    await mod.cloudDirectExec(source(), "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);");
    await expect(
      mod.cloudDirectWriteBatch(source(), [
        { sql: "INSERT INTO t (v) VALUES (?)", params: ["ok"] },
        { sql: "INSERT INTO t (v) VALUES (?)", params: [null] },
      ]),
    ).rejects.toThrow();
    const q = await mod.cloudDirectQuery(source(), "SELECT COUNT(*) AS n FROM t");
    expect(Number(q.rows[0].n)).toBe(0);
  });

  it("migrations run on the primary, are atomic, and replay safely (LinkedIn 0002)", async () => {
    const mod = await load();
    const root = path.join(tmp, "data", "databases", "outreach");
    fs.mkdirSync(path.join(root, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "migrations", "0001_init.sql"),
      "CREATE TABLE replies (id INTEGER PRIMARY KEY, prospect_id TEXT);",
    );
    fs.writeFileSync(
      path.join(root, "migrations", "0002_rename.sql"),
      "ALTER TABLE replies RENAME COLUMN prospect_id TO member_id;",
    );
    const { applyCloudDirectMigrations } = await import(
      "../src/gateway/services/cloudDirect/cloudDirectMigrations.js"
    );
    expect(await applyCloudDirectMigrations(root, localPath())).toEqual([
      "0001_init",
      "0002_rename",
    ]);

    // Simulate the fork failure: ledger lost, schema already migrated.
    await mod.cloudDirectExec(source(), "DELETE FROM _papr_schema_migrations;");
    await applyCloudDirectMigrations(root, localPath());
    const cols = await mod.cloudDirectQuery(source(), "PRAGMA table_info(replies)");
    expect(cols.rows.map((r) => r.name)).toContain("member_id");
    const ledger = await mod.cloudDirectQuery(
      source(),
      "SELECT id FROM _papr_schema_migrations ORDER BY id",
    );
    expect(ledger.rows.map((r) => r.id)).toEqual(["0001_init", "0002_rename"]);
    expect(fs.existsSync(localPath())).toBe(false);
  });
});
