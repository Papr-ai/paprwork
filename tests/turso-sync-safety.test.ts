import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  backupLocalJobDb,
  removeLocalJobDbBackup,
  restoreLocalJobDb,
} from "../src/gateway/services/tursoSyncBridgeCore.js";
import {
  countSyncLogSince,
  LOG_BATCH_LIMIT,
  maxSyncLogId,
  pruneSyncLogThrough,
} from "../src/gateway/services/tursoSyncLog.js";
import {
  evaluateBulkPullGate,
  shouldBlockPullWhileLocalDirty,
} from "../src/gateway/services/tursoPullReconcile.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

describe("turso sync safety", () => {
  it.skipIf(!canUseBetterSqlite)("countSyncLogSince counts pending entries", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT);
      CREATE TABLE _papr_sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        op TEXT NOT NULL,
        row_pk TEXT NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      `INSERT INTO _papr_sync_log (table_name, op, row_pk) VALUES ('widgets', 'insert', '[1]')`,
    ).run();
    db.prepare(
      `INSERT INTO _papr_sync_log (table_name, op, row_pk) VALUES ('widgets', 'delete', '[1]')`,
    ).run();

    expect(countSyncLogSince(db, 0)).toBe(2);
    expect(countSyncLogSince(db, 1)).toBe(1);
    expect(countSyncLogSince(db, 2)).toBe(0);
    db.close();
  });

  it.skipIf(!canUseBetterSqlite)(
    "pruneSyncLogThrough clears applied entries for bootstrap path",
    () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE _papr_sync_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          op TEXT NOT NULL,
          row_pk TEXT NOT NULL,
          changed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      for (let i = 0; i < 5; i += 1) {
        db.prepare(
          `INSERT INTO _papr_sync_log (table_name, op, row_pk) VALUES ('t', 'insert', '[${i}]')`,
        ).run();
      }
      const maxId = maxSyncLogId(db);
      pruneSyncLogThrough(db, maxId);
      expect(countSyncLogSince(db, 0)).toBe(0);
      db.close();
    },
  );

  it("LOG_BATCH_LIMIT fits within practical oplog replay batches", () => {
    expect(LOG_BATCH_LIMIT).toBe(10_000);
  });

  it("never allows full pull when local has unpushed changes", () => {
    expect(
      evaluateBulkPullGate({
        force: false,
        hadLocalUserTables: true,
        localDirty: true,
        staleConsumer: false,
      }).action,
    ).not.toBe("full_pull");

    expect(
      evaluateBulkPullGate({
        force: false,
        hadLocalUserTables: true,
        localDirty: true,
        staleConsumer: true,
      }),
    ).toEqual({ action: "skip", reason: "stale_consumer_local_dirty" });
  });

  it("blocks all pull paths when local dirty (delta, reconcile, full)", () => {
    expect(
      shouldBlockPullWhileLocalDirty({
        force: false,
        hadLocalUserTables: true,
        localDirty: true,
      }),
    ).toBe(true);
  });

  it.skipIf(!canUseBetterSqlite)("backupLocalJobDb restores on failure", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sync-backup-"));
    const dbPath = path.join(base, "data.db");
    try {
      const db = new Database(dbPath);
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
      db.prepare("INSERT INTO items (label) VALUES (?)").run("before-push");
      db.close();

      const backup = backupLocalJobDb(dbPath);

      const mutated = new Database(dbPath);
      mutated.exec("DELETE FROM items");
      mutated.prepare("INSERT INTO items (label) VALUES (?)").run("after-pull");
      mutated.close();

      restoreLocalJobDb(dbPath, backup);

      const restored = new Database(dbPath, { readonly: true });
      const rows = restored.prepare("SELECT label FROM items").all() as Array<{
        label: string;
      }>;
      restored.close();

      expect(rows).toEqual([{ label: "before-push" }]);
      removeLocalJobDbBackup(backup);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
