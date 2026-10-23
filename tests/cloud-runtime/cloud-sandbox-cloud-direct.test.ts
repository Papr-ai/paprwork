/**
 * Cloud agent sandbox runs registry databases as cloud-direct: the sandbox entry
 * point registers them + their memory-minted creds once, and the shared
 * cloud-direct routing (papr_db_exec, migrations) handles the rest.
 */
import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("seedCloudDatabaseRegistry", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-cloud-run-seed-"));
  });
  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const request = () => ({
    appId: "app-1",
    linkedSources: [{ dbId: "db-a04c5643", alias: "glow", isolation: "shared" }],
    tursoSources: [
      {
        syncKey: "db-a04c5643",
        dbPath: "/Users/x/Papr/data/databases/glow/data.db",
        databaseShortName: "d-a04c5643",
        databaseUrl: "libsql://d-a04c5643.turso.io",
        authToken: "tok",
      },
      { syncKey: "job-123", dbPath: "/x", databaseShortName: "j", databaseUrl: "u", authToken: "t" },
    ],
  });

  const readRegistry = () =>
    JSON.parse(fs.readFileSync(path.join(tmp, "data", "databases.json"), "utf8")).databases;

  it("cloud-direct: registers db-* sources as cloud-direct with memory's Turso name", async () => {
    const seed = await import(
      "../../src/gateway/services/cloudAgentGateway/seedCloudDatabaseRegistry.js"
    );
    const ids = await seed.seedCloudDatabaseRegistry(request() as never, tmp, { cloudDirect: true });
    expect(ids).toEqual(["db-a04c5643"]);
    const rec = readRegistry()["db-a04c5643"];
    expect(rec.syncMode).toBe("cloud-direct");
    expect(rec.tursoShortName).toBe("d-a04c5643");
    expect(rec.label).toBe("glow");
  });

  it("cloud-direct overrides an existing replica record (namespace workspace clone)", async () => {
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "data", "databases.json"),
      JSON.stringify({
        version: 1,
        databases: {
          "db-a04c5643": { dbId: "db-a04c5643", label: "glow", syncMode: "replica", localPath: "/p" },
        },
      }),
    );
    const seed = await import(
      "../../src/gateway/services/cloudAgentGateway/seedCloudDatabaseRegistry.js"
    );
    await seed.seedCloudDatabaseRegistry(request() as never, tmp, { cloudDirect: true });
    expect(readRegistry()["db-a04c5643"].syncMode).toBe("cloud-direct");
  });

  it("without cloud-direct, existing records are left untouched", async () => {
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    const original = { dbId: "db-a04c5643", label: "glow", syncMode: "replica", localPath: "/p" };
    fs.writeFileSync(
      path.join(tmp, "data", "databases.json"),
      JSON.stringify({ version: 1, databases: { "db-a04c5643": original } }),
    );
    const seed = await import(
      "../../src/gateway/services/cloudAgentGateway/seedCloudDatabaseRegistry.js"
    );
    expect(await seed.seedCloudDatabaseRegistry(request() as never, tmp, { cloudDirect: false })).toEqual([]);
    expect(readRegistry()["db-a04c5643"]).toEqual(original);
  });
});

describe("papr_db_exec on a cloud-direct database", () => {
  let tmp: string;
  const dbId = "db-cd-exec";
  const localPath = () => path.join(tmp, "data", "databases", "glow", "data.db");
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-cd-exec-"));
    // Replica sync OFF — exactly the cloud sandbox (TURSO_SYNC_ENABLED=false).
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
    const record = {
      dbId,
      localPath: localPath(),
      tursoShortName: "d-cd-exec",
      label: "glow",
      isolation: "shared",
      status: "active",
      syncMode: "cloud-direct",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.doMock("../../src/gateway/services/DatabaseRegistryService.js", () => ({
      initializeDatabaseRegistry: async () => ({}),
      getDatabaseRegistryService: () => ({
        getById: (id: string) => (id === dbId ? record : undefined),
        getByPath: (p: string) =>
          path.normalize(p) === path.normalize(record.localPath) ? record : undefined,
      }),
      resolveTursoDatabaseNameForSource: () => "d-cd-exec",
      tursoNameForRecord: () => "d-cd-exec",
    }));
  });

  afterEach(async () => {
    const mod = await import("../../src/gateway/services/cloudDirect/cloudDirectDb.js");
    mod.setCloudDirectClientFactoryForTests(null);
    vi.doUnmock("../../src/gateway/services/DatabaseRegistryService.js");
    vi.resetModules();
    process.env = { ...originalEnv };
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("writes to the primary even with replica sync off, and refuses DDL", async () => {
    const cd = await import("../../src/gateway/services/cloudDirect/cloudDirectDb.js");
    const primary = path.join(tmp, "primary.db");
    cd.setCloudDirectClientFactoryForTests(async () => createClient({ url: `file:${primary}` }));
    const source = { id: dbId, type: "sqlite" as const, alias: "glow", dbId, dbPath: localPath(), tables: [], linkedAt: "" };
    await cd.cloudDirectExec(source, "CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT);");

    const svc = await import("../../src/gateway/services/tursoReplica/PaprDbService.js");
    const res = await svc.paprDbExec({
      dbId,
      sql: "INSERT INTO tasks (id, status) VALUES (?, ?)",
      params: ["t1", "pending"],
    });
    expect(res.backend).toBe("cloud-direct");
    expect(res.changes).toBe(1);
    const q = await cd.cloudDirectQuery(source, "SELECT status FROM tasks WHERE id='t1'");
    expect(q.rows).toEqual([{ status: "pending" }]);
    await expect(svc.paprDbExec({ dbId, sql: "DROP TABLE tasks" })).rejects.toThrow();
    expect(fs.existsSync(localPath())).toBe(false);
  });
});

describe("setCloudDirectCredentials", () => {
  afterEach(() => vi.resetModules());

  it("is only used for databases it was given (desktop registers none)", async () => {
    const cd = await import("../../src/gateway/services/cloudDirect/cloudDirectDb.js");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-cd-creds-"));
    const file = `file:${path.join(tmp, "p.db")}`;
    cd.setCloudDirectCredentials(new Map([["d-provided", { url: file, authToken: "" }]]));
    const client = await cd.cloudDirectClientForRecord({
      dbId: "db-provided",
      tursoShortName: "d-provided",
      localPath: "/nope",
    } as never);
    const r = await client.execute("SELECT 1 AS one");
    expect(Number(r.rows[0].one)).toBe(1);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
});

describe("papr_db_query", () => {
  let tmp: string;
  const dbId = "db-cd-query";
  const originalEnv = { ...process.env };
  const record = (localPath: string, syncMode: string) => ({
    dbId, localPath, tursoShortName: "d-cd-query", label: "glow", isolation: "shared",
    status: "active", syncMode, createdAt: "", updatedAt: "",
  });
  const mockRegistry = (rec: ReturnType<typeof record>) =>
    vi.doMock("../../src/gateway/services/DatabaseRegistryService.js", () => ({
      initializeDatabaseRegistry: async () => ({}),
      getDatabaseRegistryService: () => ({
        getById: (id: string) => (id === dbId ? rec : undefined),
        getByPath: (p: string) => (path.normalize(p) === path.normalize(rec.localPath) ? rec : undefined),
      }),
      resolveTursoDatabaseNameForSource: () => "d-cd-query",
      tursoNameForRecord: () => "d-cd-query",
    }));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papr-cd-query-"));
    delete process.env.PAPR_TURSO_REPLICA_SYNC;
  });
  afterEach(async () => {
    const mod = await import("../../src/gateway/services/cloudDirect/cloudDirectDb.js");
    mod.setCloudDirectClientFactoryForTests(null);
    vi.doUnmock("../../src/gateway/services/DatabaseRegistryService.js");
    vi.resetModules();
    process.env = { ...originalEnv };
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("cloud-direct (web-only, no local file): reads rows from the primary", async () => {
    const localPath = path.join(tmp, "data", "databases", "glow", "data.db");
    mockRegistry(record(localPath, "cloud-direct"));
    const cd = await import("../../src/gateway/services/cloudDirect/cloudDirectDb.js");
    const primary = path.join(tmp, "primary.db");
    cd.setCloudDirectClientFactoryForTests(async () => createClient({ url: `file:${primary}` }));
    const source = { id: dbId, type: "sqlite" as const, alias: "glow", dbId, dbPath: localPath, tables: [], linkedAt: "" };
    await cd.cloudDirectExec(source, "CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT); INSERT INTO tasks VALUES ('a','pending'),('b','done');");

    const svc = await import("../../src/gateway/services/tursoReplica/PaprDbService.js");
    const res = await svc.paprDbQuery({ dbId, sql: "SELECT id FROM tasks WHERE status = ?", params: ["pending"] });
    expect(res.backend).toBe("cloud-direct");
    expect(res.rows).toEqual([{ id: "a" }]);
    await expect(svc.paprDbQuery({ dbId, sql: "DELETE FROM tasks" })).rejects.toThrow(/SELECT/);
    expect(fs.existsSync(localPath)).toBe(false);
  });
});

describe("job env never carries raw cloud credentials", () => {
  it("cloud-direct target → replica mode, no URL/token", async () => {
    const { jobWriteDatabaseEnv } = await import("../../src/gateway/services/jobAppDatabase.js");
    const env = jobWriteDatabaseEnv(
      [{ dbId: "db-x", alias: "glow", dbPath: "/nope/data.db", envKey: "GLOW", syncMode: "cloud-direct" }],
      "app-1",
    );
    expect(env.PAPR_DB_GLOW_MODE).toBe("replica");
    expect(Object.keys(env).some((k) => /URL|AUTH_TOKEN/.test(k))).toBe(false);
  });
});
