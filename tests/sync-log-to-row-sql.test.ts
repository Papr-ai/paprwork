import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRowWritesFromSyncLogSince,
  syncLogEntryToRowWrite,
} from "../src/gateway/services/syncV3/syncLogToRowSql.js";
import { ensureLocalDbChangeLogReady } from "../src/gateway/services/tursoSyncBridgeCore.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function openTestDb(): { dbPath: string; db: Database.Database } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-log-sql-"));
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
  return { dbPath, db };
}

describe("syncLogToRowSql", () => {
  it("converts insert sync log entry to INSERT OR REPLACE", () => {
    const { db } = openTestDb();
    db.exec(`INSERT INTO items (id, name) VALUES (1, 'alpha');`);

    db.prepare(
      `INSERT INTO _papr_sync_log (table_name, op, row_pk) VALUES (?, ?, ?)`,
    ).run("items", "insert", JSON.stringify([1]));

    const entry = db
      .prepare(`SELECT id, table_name, op, row_pk FROM _papr_sync_log ORDER BY id`)
      .get() as { id: number; table_name: string; op: string; row_pk: string };

    const write = syncLogEntryToRowWrite(db, {
      id: entry.id,
      tableName: entry.table_name,
      op: "insert",
      rowPk: JSON.parse(entry.row_pk),
    });

    expect(write?.sql).toContain('INSERT OR REPLACE INTO "items"');
    expect(write?.params?.[0]).toBe(1);
    expect(write?.params?.[1]).toBe("alpha");
    db.close();
  });

  it("reads batched row writes since cursor", () => {
    const { db } = openTestDb();
    db.exec(`INSERT INTO items (id, name) VALUES (2, 'beta');`);
    db.prepare(
      `INSERT INTO _papr_sync_log (table_name, op, row_pk) VALUES (?, ?, ?)`,
    ).run("items", "delete", JSON.stringify([2]));

    const writes = readRowWritesFromSyncLogSince(db, 0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain('DELETE FROM "items"');
    expect(writes[0]?.params).toEqual([2]);
    db.close();
  });
});
