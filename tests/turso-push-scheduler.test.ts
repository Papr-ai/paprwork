import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isJobDbDirty,
  loadTursoSyncState,
  localDbHasSyncableData,
  markDbDirty,
  recordTursoPushSuccess,
  type TursoSyncStateFile,
} from "../src/gateway/services/tursoSyncState.js";

let canUseBetterSqlite = false;
try {
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

describe("tursoSyncState", () => {
  it("marks job dirty when never pushed", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-state-"));
    const dbPath = path.join(tmpDir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");

    const state: TursoSyncStateFile = { jobs: {} };
    expect(isJobDbDirty("job-1", dbPath, state)).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!canUseBetterSqlite)(
    "marks job clean when fingerprints match last push",
    () => {
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-state-"));
      const dbPath = path.join(tmpDir, "data.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
      db.prepare("INSERT INTO items (label) VALUES (?)").run("alpha");
      db.close();

      recordTursoPushSuccess("job-1", dbPath, tmpDir);
      const state = loadTursoSyncState(tmpDir);
      expect(isJobDbDirty("job-1", dbPath, state)).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "marks job dirty after local _papr_sync_log advances",
    () => {
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      const { ensureLocalDbChangeLogReady } = require("../src/gateway/services/tursoSyncBridgeCore.js") as typeof import("../src/gateway/services/tursoSyncBridgeCore.js");
      const { maxSyncLogId } = require("../src/gateway/services/tursoSyncLog.js") as typeof import("../src/gateway/services/tursoSyncLog.js");

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-state-"));
      const dbPath = path.join(tmpDir, "data.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
      db.close();
      ensureLocalDbChangeLogReady(dbPath);

      const db2 = new Database(dbPath);
      const maxId = maxSyncLogId(db2);
      db2.close();
      recordTursoPushSuccess("job-1", dbPath, tmpDir, maxId.max_id);

      const db3 = new Database(dbPath);
      db3.prepare("INSERT INTO items (label) VALUES (?)").run("beta");
      db3.close();

      const state = loadTursoSyncState(tmpDir);
      expect(isJobDbDirty("job-1", dbPath, state)).toBe(true);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "marks job clean when only WAL sidecar changes without content edits",
    () => {
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-state-"));
      const dbPath = path.join(tmpDir, "data.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
      db.prepare("INSERT INTO items (label) VALUES (?)").run("alpha");
      db.close();

      recordTursoPushSuccess("job-1", dbPath, tmpDir);

      fs.writeFileSync(`${dbPath}-wal`, "wal");
      const state = loadTursoSyncState(tmpDir);
      expect(isJobDbDirty("job-1", dbPath, state)).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  );

  it("persists push state under Papr/data", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-state-"));
    const dbPath = path.join(tmpDir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");

    recordTursoPushSuccess("job-abc", dbPath, tmpDir);
    const loaded = loadTursoSyncState(tmpDir);
    expect(loaded.jobs["job-abc"]?.dbPath).toBe(path.normalize(dbPath));

    const statePath = path.join(tmpDir, "data", ".turso-sync-state.json");
    expect(fs.existsSync(statePath)).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("tursoPushScheduler debounceMs", () => {
  it("uses default debounce when env unset", async () => {
    delete process.env.TURSO_PUSH_DEBOUNCE_MS;
    const mod = await import("../src/gateway/services/tursoPushScheduler.js");
    expect(typeof mod.scheduleTursoPushForJob).toBe("function");
    expect(typeof mod.scheduleTursoPushAllLinked).toBe("function");
  });
});

describe("tursoPushScheduler max-wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.TURSO_PUSH_MAX_WAIT_MS = "5000";
    process.env.TURSO_PUSH_DEBOUNCE_MS = "60000";
    vi.resetModules();
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      getTursoSyncBridge: () => ({
        isJobLinkedToApp: async () => true,
        listLinkedSources: async () => [
          {
            appId: "app-max-wait",
            jobId: "job-max-wait",
            dbId: "db-max-wait",
            dbPath: "/tmp/job-max-wait/data.db",
            alias: "primary",
          },
        ],
        linkedSourceNeedsPush: async () => false,
        pushJob: async () => ({ status: "skipped" }),
      }),
    }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.TURSO_PUSH_MAX_WAIT_MS;
    const mod = await import("../src/gateway/services/tursoPushScheduler.js");
    mod.resetTursoPushQueueForTests();
    vi.resetModules();
    vi.unmock("../src/gateway/services/TursoSyncBridge.js");
  });

  it("records first dirty time and arms max-wait without resetting on reschedules", async () => {
    const mod = await import("../src/gateway/services/tursoPushScheduler.js");
    mod.resetTursoPushQueueForTests();

    mod.scheduleTursoPushForJob("job-max-wait", "normal", "watcher");
    const firstAt = mod.getFirstDirtyAtMsForTests("job-max-wait");
    expect(firstAt).toBeTypeOf("number");

    vi.advanceTimersByTime(2000);
    mod.scheduleTursoPushForJob("job-max-wait", "normal", "watcher");
    expect(mod.getFirstDirtyAtMsForTests("job-max-wait")).toBe(firstAt);

    vi.advanceTimersByTime(4000);
    await vi.runAllTimersAsync();
    await mod.awaitTursoPushQueueForTests();

    expect(mod.getFirstDirtyAtMsForTests("job-max-wait")).toBeUndefined();
  });

  it("suppresses repeat max-wait logs when job is already queued", async () => {
    vi.resetModules();
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      getTursoSyncBridge: () => ({
        isJobLinkedToApp: async () => true,
        listLinkedSources: async () => [
          {
            appId: "app-repeat-log",
            jobId: "job-repeat-log",
            dbId: "db-repeat-log",
            dbPath: "/tmp/job-repeat-log/data.db",
            alias: "primary",
          },
        ],
        linkedSourceNeedsPush: async () => true,
        pushJob: async () =>
          new Promise(() => {
            /* never resolves — keeps job in queue */
          }),
      }),
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("../src/gateway/services/tursoPushScheduler.js");
    mod.resetTursoPushQueueForTests();

    const maxWaitDetail = (args: unknown[]): boolean =>
      typeof args[0] === "string" &&
      args[0].includes("[TursoPushScheduler]") &&
      (String(args[0]).includes("max-wait elapsed") ||
        String(args[0]).includes("trigger=max_wait"));

    mod.scheduleTursoPushForJob("job-repeat-log", "normal", "watcher");
    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();

    const maxWaitLogs = logSpy.mock.calls.filter(maxWaitDetail);
    expect(maxWaitLogs.length).toBe(1);

    mod.scheduleTursoPushForJob("job-repeat-log", "normal", "watcher");
    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();

    const maxWaitLogsAfterRepeat = logSpy.mock.calls.filter(maxWaitDetail);
    expect(maxWaitLogsAfterRepeat.length).toBe(1);

    logSpy.mockRestore();
  });

  it("backs off repeat max-wait logs after push skip", async () => {
    vi.resetModules();
    process.env.TURSO_PUSH_MAX_WAIT_MS = "5000";
    process.env.TURSO_PUSH_FAILURE_BACKOFF_MS = "60000";
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      getTursoSyncBridge: () => ({
        isJobLinkedToApp: async () => true,
        listLinkedSources: async () => [
          {
            appId: "app-backoff",
            jobId: "job-backoff",
            dbId: "db-backoff",
            dbPath: "/tmp/job-backoff/data.db",
            alias: "primary",
          },
        ],
        linkedSourceNeedsPush: async () => true,
        pushJob: async () => ({ status: "skipped", tables: [], reason: "local_db_empty" }),
      }),
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("../src/gateway/services/tursoPushScheduler.js");
    mod.resetTursoPushQueueForTests();

    const maxWaitDetail = (args: unknown[]): boolean =>
      typeof args[0] === "string" &&
      args[0].includes("[TursoPushScheduler]") &&
      String(args[0]).includes("max-wait elapsed");

    mod.scheduleTursoPushForJob("job-backoff", "normal", "watcher");
    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();

    for (let i = 0; i < 20; i++) {
      mod.scheduleTursoPushForJob("job-backoff", "normal", "watcher");
    }

    const maxWaitLogs = logSpy.mock.calls.filter(maxWaitDetail);
    expect(maxWaitLogs.length).toBeLessThanOrEqual(2);

    logSpy.mockRestore();
    delete process.env.TURSO_PUSH_FAILURE_BACKOFF_MS;
  });

  it("clears max-wait after permanent push skip without repeating on idle", async () => {
    vi.resetModules();
    process.env.TURSO_PUSH_MAX_WAIT_MS = "5000";
    vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
      getTursoSyncBridge: () => ({
        isJobLinkedToApp: async () => true,
        listLinkedSources: async () => [
          {
            appId: "app-permanent-skip",
            jobId: "job-permanent-skip",
            dbId: "db-permanent-skip",
            dbPath: "/tmp/job-permanent-skip/data.db",
            alias: "primary",
          },
        ],
        linkedSourceNeedsPush: async () => true,
        pushJob: async () => ({
          status: "skipped",
          tables: [],
          reason: "no_syncable_tables",
        }),
      }),
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("../src/gateway/services/tursoPushScheduler.js");
    mod.resetTursoPushQueueForTests();

    const maxWaitDetail = (args: unknown[]): boolean =>
      typeof args[0] === "string" &&
      args[0].includes("[TursoPushScheduler]") &&
      String(args[0]).includes("trigger=max_wait");

    mod.scheduleTursoPushForJob("job-permanent-skip", "normal", "watcher");
    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();
    await mod.awaitTursoPushQueueForTests();

    expect(mod.getFirstDirtyAtMsForTests("job-permanent-skip")).toBeUndefined();

    vi.advanceTimersByTime(120_000);
    await vi.runAllTimersAsync();

    const maxWaitLogs = logSpy.mock.calls.filter(maxWaitDetail);
    expect(maxWaitLogs.length).toBe(1);

    logSpy.mockRestore();
  });
});

describe("tursoPushScheduler permanent skip integration", () => {
  let tmpPapr: string;
  let tmpJobDir: string;
  let dbPath: string;
  const syncKey = "job-empty-db";
  const dbId = "db-empty-db";

  beforeEach(() => {
    vi.useFakeTimers();
    tmpPapr = fs.mkdtempSync(path.join(os.tmpdir(), "papr-perm-skip-"));
    fs.mkdirSync(path.join(tmpPapr, "data"), { recursive: true });
    tmpJobDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-perm-skip-"));
    dbPath = path.join(tmpJobDir, "data.db");

    if (canUseBetterSqlite) {
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
      db.close();
    }

    process.env.TURSO_PUSH_MAX_WAIT_MS = "5000";
    process.env.TURSO_PUSH_DEBOUNCE_MS = "60000";
    vi.resetModules();
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.TURSO_PUSH_MAX_WAIT_MS;
    delete process.env.TURSO_PUSH_DEBOUNCE_MS;
    try {
      const mod = await import("../src/gateway/services/tursoPushScheduler.js");
      mod.resetTursoPushQueueForTests();
    } catch {
      /* module may not be loaded */
    }
    vi.resetModules();
    vi.unmock("../src/core/utils/paprRoot.js");
    vi.unmock("../src/gateway/services/TursoSyncBridge.js");
    fs.rmSync(tmpPapr, { recursive: true, force: true });
    fs.rmSync(tmpJobDir, { recursive: true, force: true });
  });

  it.skipIf(!canUseBetterSqlite)(
    "records empty fingerprints and stops max-wait for infra-only DB",
    async () => {
      expect(localDbHasSyncableData(dbPath)).toBe(false);

      markDbDirty(dbId, dbPath, tmpPapr);
      let state = loadTursoSyncState(tmpPapr);
      expect(state.jobs[dbId]?.dirtyFlag).toBe(true);
      expect(isJobDbDirty(dbId, dbPath, state)).toBe(true);

      // Spread the real module rather than listing exports by hand. The
      // hand-written version omitted getPaprDataDir, so anything reaching it
      // failed with "No export is defined on the mock" — a confusing error that
      // points at the mock instead of the missing name. Only the roots need
      // redirecting; everything else derives from them.
      vi.doMock("../src/core/utils/paprRoot.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../src/core/utils/paprRoot.js")>()),
        getPaprRoot: () => tmpPapr,
        getPaprAppsRoot: () => path.join(tmpPapr, "apps"),
      }));

      vi.doMock("../src/gateway/services/TursoSyncBridge.js", () => ({
        getTursoSyncBridge: () => ({
          isJobLinkedToApp: async () => true,
          listLinkedSources: async () => [
            {
              appId: "app-empty",
              jobId: syncKey,
              dbId,
              dbPath,
              alias: "primary",
            },
          ],
          linkedSourceNeedsPush: async () => true,
          pushJob: async () => ({
            status: "skipped",
            tables: [],
            reason: "no_syncable_tables",
          }),
        }),
      }));

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const mod = await import("../src/gateway/services/tursoPushScheduler.js");
      mod.resetTursoPushQueueForTests();

      const maxWaitDetail = (args: unknown[]): boolean =>
        typeof args[0] === "string" &&
        args[0].includes("[TursoPushScheduler]") &&
        String(args[0]).includes("trigger=max_wait");

      mod.scheduleTursoPushForJob(syncKey, "normal", "startup");
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();
      await mod.awaitTursoPushQueueForTests();

      state = loadTursoSyncState(tmpPapr);
      expect(state.jobs[dbId]?.dirtyFlag).toBeUndefined();
      expect(state.jobs[dbId]?.tableFingerprints).toBeUndefined();
      expect(isJobDbDirty(dbId, dbPath, state)).toBe(false);
      expect(mod.getFirstDirtyAtMsForTests(syncKey)).toBeUndefined();

      vi.advanceTimersByTime(120_000);
      await vi.runAllTimersAsync();

      expect(logSpy.mock.calls.filter(maxWaitDetail).length).toBe(1);
      expect(
        warnSpy.mock.calls.some(
          (args) =>
            typeof args[0] === "string" &&
            args[0].includes("no_syncable_tables"),
        ),
      ).toBe(false);

      logSpy.mockRestore();
      warnSpy.mockRestore();
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "SyncCoordinator does not schedule push for infra-only DB",
    async () => {
      const schedulerMod = await import(
        "../src/gateway/services/tursoPushScheduler.js"
      );
      const scheduleSpy = vi.spyOn(schedulerMod, "scheduleTursoPushForJob");

      const { SyncCoordinator } = await import(
        "../src/gateway/services/cloudSync/SyncCoordinator.js"
      );

      const mockSync = {
        getPaprDir: () => tmpPapr,
        enqueueRelativePath: vi.fn(),
      };

      const coordinator = new SyncCoordinator(mockSync as never);
      coordinator.markDbDirty(dbId, dbPath, "watcher");

      expect(scheduleSpy).not.toHaveBeenCalled();
      const state = loadTursoSyncState(tmpPapr);
      expect(state.jobs[dbId]).toBeUndefined();

      scheduleSpy.mockRestore();
    },
  );
});
