/**
 * Install scenario matrix — every way an app arrives in a workspace, on every
 * kind of device, through the REAL install/copy code. Only the network is fake:
 *
 *   - cloud API (prepare install)         → canned response
 *   - git clone of the publisher repo     → copy of a fixture folder
 *   - Turso                               → one libsql file per cloud database
 *                                           under <tmp>/turso/<name>.db
 *   - Turso Sync engine (replica devices) → node:sqlite file at localPath
 *
 * Scenarios: community fork, team fork, team collaborate (shared database),
 * community collaborate (must behave like a fork), copy to another workspace.
 * Devices:   replica (Apple Silicon), cloud-direct (Intel Mac / Windows ARM),
 *            local (cloud sync off).
 *
 * The fixture reproduces LinkedIn Outreach: 0002 renames a column (fails if
 * re-run) and 0003 seeds a row owned by {{papr.owner_user_id}}.
 */
import { createClient } from "@libsql/client";
import { createRequire } from "node:module";
import { promises as fs, existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installInProcessSyncWorker } from "./helpers/inProcessSyncWorker.js";

const nodeRequire = createRequire(import.meta.url);
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...p: unknown[]): Record<string, unknown>[];
    run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  close(): void;
};
let DatabaseSync: (new (file: string, opts?: { readOnly?: boolean }) => SqliteDb) | null = null;
try {
  DatabaseSync = nodeRequire("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = null;
}

// ── fixture ─────────────────────────────────────────────────────────────────
const PUBLISHER_USER = "user-publisher-0001";
const INSTALLER_USER = "user-installer-0002";
const PUBLISHER_APP_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const PUBLISHER_DB_ID = "db-5eed1234";
const SLUG = "outreach";
const MIGRATIONS: Record<string, string> = {
  "0001_init.sql":
    "CREATE TABLE prospects (id INTEGER PRIMARY KEY, name TEXT, prospect_ref TEXT, owner_user_id TEXT);",
  "0002_rename.sql": "ALTER TABLE prospects RENAME COLUMN prospect_ref TO member_id;",
  "0003_seed.sql":
    "INSERT INTO prospects (name, member_id, owner_user_id) VALUES ('Welcome', 'm-1', '{{papr.owner_user_id}}');",
};
const BROKEN = "INSERT INTO table_that_never_exists (x) VALUES (1);";

let tmp = "";
const tursoFile = (name: string) => path.join(tmp, "turso", `${name}.db`);
const deletedTurso: string[] = [];

// ── network fakes ───────────────────────────────────────────────────────────
let prepareResponse: Record<string, unknown> = {};
vi.mock("../src/gateway/utils/cloudApiClient.js", async (orig) => ({
  ...(await orig<object>()),
  cloudApiFetch: vi.fn(async (p: string) =>
    p === "/v1/cloud/apps/install"
      ? new Response(JSON.stringify(prepareResponse), { status: 200 })
      : new Response("{}", { status: 404 }),
  ),
}));

let fixtureRepo = "";
vi.mock("../src/gateway/services/cloudSync/cloudGitClone.js", async (orig) => ({
  ...(await orig<object>()),
  cloneCloudAppSource: vi.fn(async (input: { repoPath: string }) => {
    const root = await fs.mkdtemp(path.join(tmp, "clone-"));
    const repoDir = path.join(root, "repo");
    await fs.cp(fixtureRepo, repoDir, { recursive: true });
    return {
      repoDir,
      sourceDir: path.join(repoDir, input.repoPath),
      cleanup: async () => fs.rm(root, { recursive: true, force: true }),
    };
  }),
}));

vi.mock("../src/gateway/services/cloudSync/trackUpstreamRevision.js", async (orig) => ({
  ...(await orig<object>()),
  fetchPublishedAppRevision: vi.fn(async () => null),
}));

const emptySummary = { attempted: 0, pushed: 0, pulled: 0, skipped: 0, failed: 0, results: [] };
const bridge = {
  enabled: true,
  fetchCredentials: vi.fn(async (name: string) => ({
    tursoUrl: `file:${tursoFile(name)}`,
    authToken: "test",
  })),
  resolveCredentialsForReplicaOpen: vi.fn(async (name: string) => ({
    tursoUrl: `file:${tursoFile(name)}`,
    authToken: "test",
  })),
  deleteTursoDatabaseByName: vi.fn(async (name: string) => {
    deletedTurso.push(name);
    await fs.rm(tursoFile(name), { force: true });
    return true;
  }),
  pullAppLinkedSources: vi.fn(async () => emptySummary),
  getAppsRootDir: vi.fn(() => null),
  listLinkedSources: vi.fn(async () => []),
};
vi.mock("../src/gateway/services/TursoSyncBridge.js", async (orig) => {
  const real = await orig<typeof import("../src/gateway/services/TursoSyncBridge.js")>();
  // Patch the real class too: some modules construct/obtain the bridge through
  // paths the module mock does not intercept.
  const proto = real.TursoSyncBridge.prototype as unknown as Record<string, unknown>;
  for (const key of Object.keys(bridge)) {
    if (typeof (bridge as Record<string, unknown>)[key] === "function") {
      proto[key] = (bridge as Record<string, unknown>)[key];
    }
  }
  return {
    ...real,
    ensureTursoSyncBridge: vi.fn(() => bridge),
    getTursoSyncBridge: vi.fn(() => bridge),
    syncTursoAfterAppInstall: vi.fn(async () => emptySummary),
    syncTursoAfterGitPull: vi.fn(async () => emptySummary),
  };
});

// Replica engine stand-in: a plain SQLite file at localPath. No real sync —
// replica scenarios check the local replica; the primary is checked through
// the paired HTTP apply that migrations also do (libsql file above).
vi.mock("@tursodatabase/sync", () => ({
  connect: vi.fn(async (opts: { path: string }) => {
    mkdirSync(path.dirname(opts.path), { recursive: true });
    const db = new DatabaseSync!(opts.path);
    const stmt = (sql: string) => {
      const s = db.prepare(sql);
      return {
        all: async (...p: unknown[]) => s.all(...p),
        run: async (...p: unknown[]) => s.run(...p),
        get: async (...p: unknown[]) => s.all(...p)[0],
      };
    };
    return {
      connect: async () => undefined,
      prepare: async (sql: string) => stmt(sql),
      exec: async (sql: string) => db.exec(sql),
      transactionAsync: <T>(fn: (txn: unknown) => Promise<T>) => ({
        immediate: async () => {
          db.exec("BEGIN IMMEDIATE");
          try {
            const out = await fn({
              prepare: async (sql: string) => stmt(sql),
              exec: async (sql: string) => db.exec(sql),
            });
            db.exec("COMMIT");
            return out;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      }),
      pull: async () => false,
      push: async () => undefined,
      checkpoint: async () => undefined,
      stats: async () => ({ cdcOperations: 0 }),
      close: async () => db.close(),
    };
  }),
}));
installInProcessSyncWorker();

// ── device profiles ─────────────────────────────────────────────────────────
type Device = "replica" | "cloud-direct" | "local";
const DEVICE_ENV: Record<Device, Record<string, string>> = {
  replica: { CLOUD_SYNC_ENABLED: "true", PAPR_TURSO_REPLICA_NATIVE: "1" },
  "cloud-direct": { CLOUD_SYNC_ENABLED: "true", PAPR_TURSO_REPLICA_NATIVE: "0" },
  local: { CLOUD_SYNC_ENABLED: "false", PAPR_TURSO_REPLICA_NATIVE: "1" },
};
const EXPECTED_FORK_MODE: Record<Device, string | undefined> = {
  replica: "replica",
  "cloud-direct": "cloud-direct",
  local: undefined,
};
const DEVICES: Device[] = ["replica", "cloud-direct", "local"];

// ── helpers ─────────────────────────────────────────────────────────────────
async function writeFixtureRepo(opts: { broken?: boolean; snapshot?: boolean }) {
  fixtureRepo = path.join(tmp, `fixture-${Math.random().toString(36).slice(2, 8)}`);
  const appDir = path.join(fixtureRepo, "apps", PUBLISHER_APP_ID);
  const slugDir = path.join(fixtureRepo, "data", "databases", SLUG);
  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(path.join(slugDir, "migrations"), { recursive: true });
  await fs.writeFile(path.join(appDir, "index.html"), "<h1>Outreach</h1>");
  await fs.writeFile(path.join(appDir, "metadata.json"), JSON.stringify({ title: "Outreach" }));
  await fs.writeFile(
    path.join(appDir, "data-sources.json"),
    JSON.stringify({
      sources: [
        {
          id: `${PUBLISHER_DB_ID}:outreach`,
          type: "sqlite",
          dbId: PUBLISHER_DB_ID,
          alias: "outreach",
          dbPath: "",
          tables: [],
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
  const migrations = { ...MIGRATIONS, ...(opts.broken ? { "0004_broken.sql": BROKEN } : {}) };
  for (const [file, sql] of Object.entries(migrations)) {
    await fs.writeFile(path.join(slugDir, "migrations", file), sql);
  }
  await fs.writeFile(
    path.join(fixtureRepo, "data", "databases.json"),
    JSON.stringify({
      version: 1,
      databases: {
        [PUBLISHER_DB_ID]: {
          dbId: PUBLISHER_DB_ID,
          localPath: `/Users/publisher/Papr/data/databases/${SLUG}/data.db`,
          tursoShortName: "d-5eed1234",
          label: "Outreach",
          isolation: "shared",
          status: "active",
          syncMode: "replica",
          schemaOwnerAppId: PUBLISHER_APP_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }),
  );
  await fs.writeFile(path.join(fixtureRepo, "data", "jobs.json"), "[]");
  if (opts.snapshot) {
    await writeSnapshot(slugDir);
  }
}

/** Publisher's real schema → snapshot.json, exactly as publish does. */
async function writeSnapshot(slugDir: string) {
  const pub = new DatabaseSync!(":memory:");
  for (const sql of Object.values(MIGRATIONS)) {
    pub.exec(sql.replace("{{papr.owner_user_id}}", PUBLISHER_USER));
  }
  const rows = pub
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
    .all();
  pub.close();
  const { buildSchemaSnapshot, writeSchemaSnapshot } = await import(
    "../src/gateway/services/jobs/schemaSnapshot.js"
  );
  const snapshot = await buildSchemaSnapshot({
    migrationRoot: slugDir,
    schemaRows: rows as never,
    appliedLedgerIds: new Set(Object.keys(MIGRATIONS).map((f) => f.replace(/\.sql$/, ""))),
  });
  expect(snapshot, "fixture snapshot should build").not.toBeNull();
  await writeSchemaSnapshot(slugDir, snapshot);
}

/** The publisher's live team database: all migrations applied + real data. */
async function seedPublisherPrimary() {
  const client = createClient({ url: `file:${tursoFile("d-5eed1234")}` });
  for (const sql of Object.values(MIGRATIONS)) {
    await client.execute(sql.replace("{{papr.owner_user_id}}", PUBLISHER_USER));
  }
  await client.execute(
    "INSERT INTO prospects (name, member_id, owner_user_id) VALUES ('Publisher lead', 'm-9', ?)",
    [PUBLISHER_USER],
  );
  await client.execute(
    "CREATE TABLE _papr_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT, source TEXT, content_hash TEXT)",
  );
  for (const file of Object.keys(MIGRATIONS)) {
    await client.execute("INSERT INTO _papr_schema_migrations (id) VALUES (?)", [
      file.replace(/\.sql$/, ""),
    ]);
  }
  client.close();
}

async function useWorkspace(org: string, ns: string) {
  const { ensureWorkspaceLayout, writeActiveWorkspacePointer } = await import(
    "../src/core/utils/paprWorkspace.js"
  );
  const pointer = await ensureWorkspaceLayout({ organizationId: org, namespaceId: ns });
  await writeActiveWorkspacePointer(pointer);
  const { resetDatabaseRegistryForWorkspaceSwitch } = await import(
    "../src/gateway/services/DatabaseRegistryService.js"
  );
  resetDatabaseRegistryForWorkspaceSwitch();
  const { resetAppServiceSingletonForTests } = await import(
    "../src/gateway/services/AppService.js"
  );
  resetAppServiceSingletonForTests();
  return pointer.paprHome;
}

interface DbRecordLike {
  dbId: string;
  localPath: string;
  syncMode?: string;
  tursoShortName: string;
  isolation?: string;
}

async function linkedRecord(paprHome: string, appId: string): Promise<DbRecordLike | undefined> {
  const ds = JSON.parse(
    await fs.readFile(path.join(paprHome, "apps", appId, "data-sources.json"), "utf8"),
  ) as { sources: Array<{ dbId?: string }> };
  const registry = JSON.parse(
    await fs.readFile(path.join(paprHome, "data", "databases.json"), "utf8"),
  ) as { databases: Record<string, DbRecordLike> };
  const dbId = ds.sources[0]?.dbId;
  return dbId ? registry.databases[dbId] : undefined;
}

interface DbState {
  where: "local file" | "cloud primary" | "missing";
  columns: string[];
  rows: Array<{ name: string; owner: string }>;
  ledger: string[];
}

async function readDb(record: DbRecordLike): Promise<DbState> {
  const empty = (where: DbState["where"]): DbState => ({ where, columns: [], rows: [], ledger: [] });
  const ledgerSql = (t: string) => `SELECT id FROM ${t}`;
  if (record.syncMode === "cloud-direct") {
    const file = tursoFile(record.tursoShortName);
    if (!existsSync(file)) return empty("missing");
    const c = createClient({ url: `file:${file}` });
    try {
      const q = async (sql: string) => (await c.execute(sql)).rows as unknown as Record<string, unknown>[];
      const tables = (await q("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => String(r.name));
      const ledger = new Set<string>();
      for (const t of ["schema_migrations", "_papr_schema_migrations"].filter((t) => tables.includes(t))) {
        for (const r of await q(ledgerSql(t))) { const id = String(r.id).replace(/\.sql$/, ""); if (id !== "0001_baseline") ledger.add(id); }
      }
      if (!tables.includes("prospects")) return { ...empty("cloud primary"), ledger: [...ledger].sort() };
      return {
        where: "cloud primary",
        columns: (await q("PRAGMA table_info(prospects)")).map((r) => String(r.name)),
        rows: (await q("SELECT name, owner_user_id AS owner FROM prospects ORDER BY id")) as never,
        ledger: [...ledger].sort(),
      };
    } finally {
      c.close();
    }
  }
  if (!existsSync(record.localPath)) return empty("missing");
  const db = new DatabaseSync!(record.localPath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    const ledger = new Set<string>();
    for (const t of ["schema_migrations", "_papr_schema_migrations"].filter((t) => tables.includes(t))) {
      for (const r of db.prepare(ledgerSql(t)).all()) { const id = String(r.id).replace(/\.sql$/, ""); if (id !== "0001_baseline") ledger.add(id); }
    }
    if (!tables.includes("prospects")) return { ...empty("local file"), ledger: [...ledger].sort() };
    return {
      where: "local file",
      columns: db.prepare("PRAGMA table_info(prospects)").all().map((r) => String(r.name)),
      rows: db.prepare("SELECT name, owner_user_id AS owner FROM prospects ORDER BY id").all() as never,
      ledger: [...ledger].sort(),
    };
  } finally {
    db.close();
  }
}

type InstallKind = "community-fork" | "team-fork" | "team-collaborate" | "community-collaborate";
const INSTALL_INPUT: Record<InstallKind, Record<string, unknown>> = {
  "community-fork": { mode: "fork", catalogScope: "global" },
  "team-fork": { mode: "fork", catalogScope: "namespace", visibility: "team" },
  "team-collaborate": { mode: "track", catalogScope: "namespace", visibility: "team" },
  "community-collaborate": { mode: "track", catalogScope: "global" },
};

async function runInstall(kind: InstallKind) {
  const input = INSTALL_INPUT[kind];
  prepareResponse = {
    mode: input.mode,
    source: {
      orgId: "org-pub",
      namespaceId: "ns-pub",
      userId: PUBLISHER_USER,
      appId: PUBLISHER_APP_ID,
      slug: SLUG,
    },
    repoPath: `apps/${PUBLISHER_APP_ID}`,
    cloneUrl: "https://example.invalid/repo.git",
    token: "t",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    lineageId: "lin-1",
  };
  const { getCloudAppInstallService } = await import(
    "../src/gateway/services/CloudAppInstallService.js"
  );
  return getCloudAppInstallService().installApp({
    namespaceId: "ns-pub",
    slug: SLUG,
    ...(input as object),
  } as never);
}

const expectFreshFork = (state: DbState, owner: string) => {
  expect.soft(state.where, "database exists where the storage mode says").not.toBe("missing");
  expect.soft(state.columns, "0002 rename applied").toContain("member_id");
  expect.soft(state.columns, "old column gone").not.toContain("prospect_ref");
  expect.soft(state.rows, "only the seeded row, owned by the installer — no publisher data").toEqual([
    { name: "Welcome", owner },
  ]);
  expect.soft(state.ledger, "one ledger entry per migration").toEqual([
    "0001_init",
    "0002_rename",
    "0003_seed",
  ]);
};

// ── suite ───────────────────────────────────────────────────────────────────
const savedEnv = { ...process.env };

describe.skipIf(!DatabaseSync)("install scenario matrix", () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "papr-matrix-"));
    await fs.mkdir(path.join(tmp, "turso"), { recursive: true });
    deletedTurso.length = 0;
    process.env.HOME = path.join(tmp, "home");
    delete process.env.PAPR_HOME;
    process.env.PAPR_TURSO_REPLICA_SYNC = "replica-records";
    process.env.PAPR_TURSO_REPLICA_SYNC_ALLOW_PRODUCTION = "1";
    process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = INSTALLER_USER;
    const { setCloudDirectClientFactoryForTests } = await import(
      "../src/gateway/services/cloudDirect/cloudDirectDb.js"
    );
    setCloudDirectClientFactoryForTests(async (name) => createClient({ url: `file:${tursoFile(name)}` }));
    const { setTursoReplicaOnlineForTests } = await import("../src/gateway/utils/tursoReplicaEnabled.js");
    setTursoReplicaOnlineForTests(null);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    const { shutdownTursoReplicaSyncWorker } = await import(
      "../src/gateway/services/tursoReplica/TursoReplicaSyncWorkerClient.js"
    );
    await shutdownTursoReplicaSyncWorker().catch(() => undefined);
    const { setCloudDirectClientFactoryForTests } = await import(
      "../src/gateway/services/cloudDirect/cloudDirectDb.js"
    );
    setCloudDirectClientFactoryForTests(null);
    vi.restoreAllMocks();
    // Mutate, never reassign: a replaced process.env is a plain object that
    // os.homedir() no longer sees, and every later test leaks into one HOME.
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  const withDevice = (device: Device) => Object.assign(process.env, DEVICE_ENV[device]);

  for (const device of DEVICES) {
    describe(`device: ${device}`, () => {
      for (const kind of ["community-fork", "team-fork", "community-collaborate"] as const) {
        for (const snapshot of [false, true]) {
          it(`${kind} (${snapshot ? "snapshot" : "replay"}) → fresh database, installer owns seed`, async () => {
            withDevice(device);
            await writeFixtureRepo({ snapshot });
            const home = await useWorkspace("org-me", "ns-me");
            const result = await runInstall(kind);
            expect.soft(result.bootstrap.errors).toEqual([]);
            const record = await linkedRecord(home, result.app.id);
            expect(record, "registry record for the installed database").toBeDefined();
            expect.soft(record!.dbId, "fork gets its own database id").not.toBe(PUBLISHER_DB_ID);
            expect.soft(record!.syncMode, "storage mode chosen for this device").toBe(
              EXPECTED_FORK_MODE[device],
            );
            expectFreshFork(await readDb(record!), INSTALLER_USER);
          });
        }
      }

      it("team-collaborate → uses the publisher's database, nothing re-run, no duplicate seed", async () => {
        withDevice(device);
        await writeFixtureRepo({ snapshot: true });
        await seedPublisherPrimary();
        const home = await useWorkspace("org-pub", "ns-team-member");
        const result = await runInstall("team-collaborate");
        expect.soft(result.bootstrap.errors).toEqual([]);
        const record = await linkedRecord(home, result.app.id);
        expect(record).toBeDefined();
        expect.soft(record!.dbId, "collaborate keeps the publisher's database id").toBe(PUBLISHER_DB_ID);
        // The publisher's primary is the source of truth — check it was not touched.
        const primary = await readDb({ ...record!, syncMode: "cloud-direct", tursoShortName: "d-5eed1234" });
        expect.soft(primary.rows, "publisher data intact; seed not applied a second time").toEqual([
          { name: "Welcome", owner: PUBLISHER_USER },
          { name: "Publisher lead", owner: PUBLISHER_USER },
        ]);
        if (device === "cloud-direct") {
          expect.soft(record!.syncMode).toBe("cloud-direct");
          expect.soft(existsSync(record!.localPath), "cloud-direct keeps no local copy").toBe(false);
        }
      });

      it("fork with a migration that always fails → nothing left behind", async () => {
        withDevice(device);
        await writeFixtureRepo({ broken: true });
        const home = await useWorkspace("org-me", "ns-me");
        await expect(runInstall("community-fork")).rejects.toThrow();
        const apps = JSON.parse(await fs.readFile(path.join(home, "data", "apps.json"), "utf8").catch(() => "[]"));
        expect.soft(apps.filter((a: { title?: string }) => a.title?.startsWith("Outreach")), "no app left in the workspace").toEqual([]);
        const registry = JSON.parse(
          await fs.readFile(path.join(home, "data", "databases.json"), "utf8").catch(() => '{"databases":{}}'),
        );
        expect.soft(Object.values(registry.databases as Record<string, { label?: string }>).filter((d) => d.label?.startsWith("Outreach")).map((d) => d), "no database record left").toEqual([]);
        const dbDirs = await fs.readdir(path.join(home, "data", "databases")).catch(() => []);
        expect.soft(dbDirs.filter((d: string) => d.startsWith("outreach")), "no database folder left").toEqual([]);
        const leftoverPrimaries = (await fs.readdir(path.join(tmp, "turso"))).filter((f) => f !== "d-5eed1234.db");
        expect.soft(leftoverPrimaries, "no cloud database left").toEqual([]);
      });

      it("copy to another workspace → fresh database, finished on first switch", async () => {
        withDevice(device);
        await writeFixtureRepo({ snapshot: false });
        const sourceHome = await useWorkspace("org-me", "ns-src");
        const installed = await runInstall("community-fork");
        const { copyAppToNamespace } = await import("../src/gateway/services/copyAppToNamespace.js");
        const copy = await copyAppToNamespace({
          appId: installed.app.id,
          targetOrganizationId: "org-other",
          targetNamespaceId: "ns-dst",
          sourcePaprHome: sourceHome,
        });
        // First switch into the target workspace finishes the cloud side.
        const targetHome = await useWorkspace("org-other", "ns-dst");
        const { initializeDatabaseRegistry } = await import(
          "../src/gateway/services/DatabaseRegistryService.js"
        );
        await initializeDatabaseRegistry();
        const { setTursoReplicaOnlineForTests } = await import("../src/gateway/utils/tursoReplicaEnabled.js");
        if (device !== "local") setTursoReplicaOnlineForTests(true);
        const { rebootstrapPendingPortableReplicas } = await import(
          "../src/gateway/services/tursoReplica/portableReplicaBootstrap.js"
        );
        const finish = await rebootstrapPendingPortableReplicas();
        expect.soft(JSON.stringify(finish.failed), "switch-time finish had no failures").toBe("[]");

        const record = await linkedRecord(targetHome, copy.appId);
        expect(record).toBeDefined();
        const sourceRecord = await linkedRecord(sourceHome, installed.app.id);
        expect.soft(record!.dbId, "copy gets its own database").not.toBe(sourceRecord!.dbId);
        expect.soft(record!.syncMode, "storage mode chosen for this device").toBe(EXPECTED_FORK_MODE[device]);
        expectFreshFork(await readDb(record!), INSTALLER_USER);
        // Source untouched.
        expectFreshFork(await readDb(sourceRecord!), INSTALLER_USER);
      });
    });
  }
});
