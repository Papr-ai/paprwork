import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import {
  clearStaleDirtyFlagIfClean,
  hasUnpushedLocalDbChanges,
  isLinkedSourceDirtyFast,
  loadTursoSyncState,
  markDbDirty,
  recordTursoPushSuccess,
  saveTursoSyncState,
  type TursoSyncStateFile,
} from "../src/gateway/services/tursoSyncState.js";
import {
  ensureLocalDbChangeLogReady,
  SYNC_LOG_TABLE,
} from "../src/gateway/services/tursoSyncLog.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

const describeSqlite = canUseBetterSqlite ? describe : describe.skip;

function tempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-dirty-fast-"));
  const dbPath = path.join(dir, "data.db");
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describeSqlite("isLinkedSourceDirtyFast", () => {
  let dbPath: string;
  let cleanup: () => void;
  let paprDir: string;
  let state: TursoSyncStateFile;

  beforeEach(() => {
    ({ dbPath, cleanup } = tempDb());
    paprDir = path.dirname(path.dirname(dbPath));
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });

    const db = new Database(dbPath);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    db.close();

    ensureLocalDbChangeLogReady(dbPath);
    state = { jobs: {} };
  });

  afterEach(() => {
    cleanup();
  });

  it("returns true when never pushed", () => {
    expect(isLinkedSourceDirtyFast("job-1", dbPath, state)).toBe(true);
  });

  it("returns true immediately after markDbDirty", () => {
    markDbDirty("job-1", dbPath, paprDir);
    const loaded = loadTursoSyncState(paprDir);
    expect(isLinkedSourceDirtyFast("job-1", dbPath, loaded)).toBe(true);
  });

  it("returns false after recordTursoPushSuccess clears dirtyFlag", () => {
    markDbDirty("job-1", dbPath, paprDir);
    recordTursoPushSuccess("job-1", dbPath, paprDir);
    const loaded = loadTursoSyncState(paprDir);
    expect(loaded.jobs["job-1"]?.dirtyFlag).toBeUndefined();
    expect(isLinkedSourceDirtyFast("job-1", dbPath, loaded)).not.toBe(true);
  });

  it("returns false when oplog cursor matches last push", () => {
    const db = new Database(dbPath);
    const maxId = db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${SYNC_LOG_TABLE}`)
      .get() as { max_id: number };
    db.close();

    state.jobs["job-1"] = {
      dbPath,
      lastPushAt: new Date().toISOString(),
      lastPushedLogId: maxId.max_id,
    };
    saveTursoSyncState(state, paprDir);
    const loaded = loadTursoSyncState(paprDir);

    expect(isLinkedSourceDirtyFast("job-1", dbPath, loaded)).toBe(false);
  });

  it("returns true when oplog advanced beyond lastPushedLogId", () => {
    state.jobs["job-1"] = {
      dbPath,
      lastPushAt: new Date().toISOString(),
      lastPushedLogId: 0,
    };
    saveTursoSyncState(state, paprDir);

    const db = new Database(dbPath);
    db.prepare("INSERT INTO items (name) VALUES (?)").run("alpha");
    db.close();

    const loaded = loadTursoSyncState(paprDir);
    expect(isLinkedSourceDirtyFast("job-1", dbPath, loaded)).toBe(true);
  });

  it("does not set dirtyFlag on WAL-only watcher signal after successful push", () => {
    const db = new Database(dbPath);
    const maxId = db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${SYNC_LOG_TABLE}`)
      .get() as { max_id: number };
    db.close();

    recordTursoPushSuccess("job-1", dbPath, paprDir, maxId.max_id);

    markDbDirty("job-1", dbPath, paprDir);

    const loaded = loadTursoSyncState(paprDir);
    expect(loaded.jobs["job-1"]?.dirtyFlag).toBeUndefined();
    expect(hasUnpushedLocalDbChanges("job-1", dbPath, loaded)).toBe(false);
    expect(isLinkedSourceDirtyFast("job-1", dbPath, loaded)).not.toBe(true);
  });

  it("clears stale dirtyFlag when content matches last push", () => {
    const db = new Database(dbPath);
    const maxId = db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${SYNC_LOG_TABLE}`)
      .get() as { max_id: number };
    db.close();

    recordTursoPushSuccess("job-1", dbPath, paprDir, maxId.max_id);
    state = loadTursoSyncState(paprDir);
    state.jobs["job-1"] = {
      ...state.jobs["job-1"]!,
      dirtyFlag: true,
      dirtyFlagAt: new Date().toISOString(),
    };
    saveTursoSyncState(state, paprDir);

    expect(
      clearStaleDirtyFlagIfClean("job-1", dbPath, paprDir),
    ).toBe(true);

    const loaded = loadTursoSyncState(paprDir);
    expect(loaded.jobs["job-1"]?.dirtyFlag).toBeUndefined();
    expect(isLinkedSourceDirtyFast("job-1", dbPath, loaded)).not.toBe(true);
  });
});

describe("loadTursoSyncState legacy fingerprint cleanup", () => {
  let paprDir: string;

  beforeEach(() => {
    paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sync-state-"));
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(paprDir, { recursive: true, force: true });
  });

  it("strips deprecated tableFingerprints on load", () => {
    const statePath = path.join(paprDir, "data", ".turso-sync-state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        jobs: {
          "job-legacy": {
            dbPath: "/tmp/data.db",
            lastPushAt: "2026-01-01T00:00:00.000Z",
            tableFingerprints: { items: "abc123" },
            lastPushedLogId: 4,
          },
        },
      }),
      "utf8",
    );

    const loaded = loadTursoSyncState(paprDir);
    expect(loaded.jobs["job-legacy"]?.lastPushedLogId).toBe(4);
    expect(loaded.jobs["job-legacy"]?.tableFingerprints).toBeUndefined();
  });
});
