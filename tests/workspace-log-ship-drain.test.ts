import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSyncLogShipBatch,
  SYNC_LOG_SHIP_READ_LIMIT,
} from "../src/gateway/services/syncV3/syncLogToRowSql.js";
import { ensureLocalDbChangeLogReady } from "../src/gateway/services/tursoSyncBridgeCore.js";
import { TURSO_SYNC_STATE_FILENAME } from "../src/gateway/services/tursoSyncState.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

const tempDirs: string[] = [];
const appendCalls: unknown[][] = [];
let testPaprRoot = "";

vi.mock("../src/gateway/services/syncV3/workspaceLogGenesisCutover.js", () => ({
  ensureWorkspaceLogGenesisForDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/gateway/services/syncV3/WorkspaceLogClient.js", () => ({
  WORKSPACE_LOG_SHIP_BATCH_SIZE: 500,
  appendWorkspaceLogBatch: vi.fn(async (...args: unknown[]) => {
    appendCalls.push(args);
    return { appended: 1 };
  }),
}));

vi.mock("../src/gateway/services/DatabaseRegistryService.js", () => ({
  resolveTursoDatabaseNameForSource: () => "d-test-replica",
}));

vi.mock("../src/gateway/services/workspaceWriteGuard.js", () => ({
  getWorkspaceWriteGeneration: () => 1,
  canPerformWorkspaceDbWrite: () => true,
}));

vi.mock("../src/core/utils/paprRoot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/utils/paprRoot.js")>();
  return {
    ...actual,
    getPaprRoot: () => testPaprRoot || actual.getPaprRoot(),
  };
});

afterEach(() => {
  appendCalls.length = 0;
  testPaprRoot = "";
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

function seedSyncLogEntries(db: Database.Database, count: number): void {
  for (let i = 1; i <= count; i += 1) {
    db.exec(`INSERT INTO items (id, name) VALUES (${i}, 'row-${i}');`);
  }
}

describe("readSyncLogShipBatch", () => {
  it.skipIf(!canUseBetterSqlite)(
    "reports hasMore when the read hits the batch limit",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-ship-batch-"));
      tempDirs.push(dir);
      const dbPath = path.join(dir, "data.db");
      const bootstrap = new Database(dbPath);
      bootstrap.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
      bootstrap.close();
      ensureLocalDbChangeLogReady(dbPath);

      const db = new Database(dbPath);
      seedSyncLogEntries(db, SYNC_LOG_SHIP_READ_LIMIT + 50);

      const first = readSyncLogShipBatch(db, 0);
      expect(first.writes.length).toBeGreaterThan(0);
      expect(first.hasMore).toBe(true);
      expect(first.highWaterLogId).toBeGreaterThan(0);

      const second = readSyncLogShipBatch(db, first.highWaterLogId);
      expect(second.hasMore).toBe(false);
      expect(second.highWaterLogId).toBeGreaterThan(first.highWaterLogId);

      db.close();
    },
  );
});

describe("shipLinkedSourceToWorkspaceLog drain loop", () => {
  it.skipIf(!canUseBetterSqlite)(
    "ships the full changelog in one push call",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-ship-drain-"));
      tempDirs.push(dir);
      testPaprRoot = path.join(dir, "papr");
      const dbPath = path.join(testPaprRoot, "Jobs", "job-1", "data", "data.db");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });

      const bootstrap = new Database(dbPath);
      bootstrap.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
      bootstrap.close();
      ensureLocalDbChangeLogReady(dbPath);

      const db = new Database(dbPath);
      const entryCount = SYNC_LOG_SHIP_READ_LIMIT + 120;
      seedSyncLogEntries(db, entryCount);
      db.close();

      vi.resetModules();
      const { shipLinkedSourceToWorkspaceLog } = await import(
        "../src/gateway/services/syncV3/workspaceLogSync.js"
      );

      const result = await shipLinkedSourceToWorkspaceLog({
        appId: "app-1",
        jobId: "job-1",
        dbPath,
        alias: "primary",
      });

      expect(result.shipped).toBe(entryCount);
      expect(appendCalls.length).toBeGreaterThan(1);

      const statePath = path.join(testPaprRoot, "data", TURSO_SYNC_STATE_FILENAME);
      expect(fs.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
        jobs: Record<string, { lastPushedLogId?: number }>;
      };
      const jobState = Object.values(state.jobs)[0];
      expect(jobState?.lastPushedLogId).toBe(entryCount);
    },
  );
});
