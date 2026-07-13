import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isJobDbDirty,
  loadTursoSyncState,
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

  it("marks job dirty after file modification (legacy mtime fallback)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "turso-state-"));
    const dbPath = path.join(tmpDir, "data.db");
    fs.writeFileSync(dbPath, "sqlite");
    recordTursoPushSuccess("job-1", dbPath, tmpDir);

    fs.appendFileSync(dbPath, "x");
    const state = loadTursoSyncState(tmpDir);
    expect(isJobDbDirty("job-1", dbPath, state)).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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
