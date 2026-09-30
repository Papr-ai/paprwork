import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { Client } from "@libsql/client";
import {
  compactSyncLogEntries,
  ensureLocalTableSyncTriggers,
  type SyncLogEntry,
} from "../src/gateway/services/tursoSyncLog.js";
import { pushDeltaToRemote } from "../src/gateway/services/tursoDeltaPush.js";
import { REMOTE_INSERT_CHUNK_ROWS } from "../src/gateway/services/tursoBulkInsert.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

vi.mock("../src/gateway/services/tursoTablePrep.js", () => ({
  prepareRemoteTableForSync: vi.fn(async () => [
    { name: "id", type: "INTEGER", primaryKey: true },
    { name: "label", type: "TEXT", primaryKey: false },
  ]),
}));

describe("compactSyncLogEntries", () => {
  it("keeps the last op per table and primary key", () => {
    const entries: SyncLogEntry[] = [
      { id: 1, tableName: "events", op: "insert", rowPk: [1] },
      { id: 2, tableName: "events", op: "update", rowPk: [1] },
      { id: 3, tableName: "events", op: "delete", rowPk: [1] },
      { id: 4, tableName: "events", op: "insert", rowPk: [2] },
    ];
    const compacted = compactSyncLogEntries(entries);
    expect(compacted).toHaveLength(2);
    expect(compacted.map((entry) => entry.id)).toEqual([3, 4]);
  });
});

describe("pushDeltaToRemote batching", () => {
  it.skipIf(!canUseBetterSqlite)(
    "uses chunked multi-row upserts and batched deletes",
    async () => {
    const execute = vi.fn(async (query: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof query === "string" ? query : query.sql;
      if (sql.includes("PRAGMA table_info")) {
        return {
          rows: [
            { name: "id", type: "INTEGER", pk: 1 },
            { name: "label", type: "TEXT", pk: 0 },
          ],
          columns: [],
        };
      }
      return { rows: [], columns: [] };
    });
    const remote = { execute } as unknown as Client;

    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL
      );
    `);
    ensureLocalTableSyncTriggers(db, "events");

    const insert = db.prepare("INSERT INTO events (id, label) VALUES (?, ?)");
    const rowCount = REMOTE_INSERT_CHUNK_ROWS + 25;
    const tx = db.transaction((count: number) => {
      for (let i = 1; i <= count; i += 1) {
        insert.run(i, `row-${i}`);
      }
    });
    tx(rowCount);

    db.prepare("DELETE FROM events WHERE id = 1").run();

    const entries = db
      .prepare(
        `SELECT id, table_name, op, row_pk FROM _papr_sync_log ORDER BY id ASC`,
      )
      .all()
      .map((row) => ({
        id: Number((row as { id: number }).id),
        tableName: String((row as { table_name: string }).table_name),
        op: String((row as { op: string }).op) as SyncLogEntry["op"],
        rowPk: JSON.parse(String((row as { row_pk: string }).row_pk)) as unknown[],
      }));

    const touched = await pushDeltaToRemote(db, remote, entries);
    expect(touched).toEqual(["events"]);

    const upsertCalls = execute.mock.calls.filter((call) => {
      const query = call[0] as string | { sql: string };
      const sql = typeof query === "string" ? query : query.sql;
      return sql.includes("INSERT OR REPLACE INTO");
    });
    expect(upsertCalls.length).toBeGreaterThanOrEqual(2);
    expect(upsertCalls[0]![0]).toMatchObject({
      sql: expect.stringContaining("INSERT OR REPLACE INTO"),
    });
    const firstUpsertSql =
      typeof upsertCalls[0]![0] === "string"
        ? upsertCalls[0]![0]
        : (upsertCalls[0]![0] as { sql: string }).sql;
    expect(firstUpsertSql.match(/\(\?, \?\)/g)?.length).toBe(REMOTE_INSERT_CHUNK_ROWS);

    const deleteCalls = execute.mock.calls.filter((call) => {
      const query = call[0] as string | { sql: string };
      const sql = typeof query === "string" ? query : query.sql;
      return sql.includes("DELETE FROM") && sql.includes(" IN (");
    });
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);

    db.close();
  },
  );

  it.skipIf(!canUseBetterSqlite)(
    "deletes child rows before parent rows when FK refs exist",
    async () => {
    const deleteOrder: string[] = [];
    const execute = vi.fn(async (query: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof query === "string" ? query : query.sql;
      if (sql.includes("PRAGMA table_info")) {
        const tableName = sql.match(/"([^"]+)"/)?.[1] ?? "";
        if (tableName === "parents") {
          return {
            rows: [
              { name: "id", type: "INTEGER", pk: 1 },
              { name: "label", type: "TEXT", pk: 0 },
            ],
            columns: [],
          };
        }
        return {
          rows: [
            { name: "id", type: "INTEGER", pk: 1 },
            { name: "parent_id", type: "INTEGER", pk: 0 },
          ],
          columns: [],
        };
      }
      if (sql.includes("DELETE FROM")) {
        if (sql.includes('"parents"')) {
          deleteOrder.push("parents");
        } else if (sql.includes('"children"')) {
          deleteOrder.push("children");
        }
      }
      return { rows: [], columns: [] };
    });
    const remote = { execute } as unknown as Client;

    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE parents (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL
      );
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parents(id)
      );
    `);
    ensureLocalTableSyncTriggers(db, "parents");
    ensureLocalTableSyncTriggers(db, "children");
    db.prepare("INSERT INTO parents (id, label) VALUES (1, 'p')").run();
    db.prepare("INSERT INTO children (id, parent_id) VALUES (1, 1)").run();
    db.prepare("DELETE FROM children WHERE id = 1").run();
    db.prepare("DELETE FROM parents WHERE id = 1").run();

    const entries = db
      .prepare(
        `SELECT id, table_name, op, row_pk FROM _papr_sync_log ORDER BY id ASC`,
      )
      .all()
      .map((row) => ({
        id: Number((row as { id: number }).id),
        tableName: String((row as { table_name: string }).table_name),
        op: String((row as { op: string }).op) as SyncLogEntry["op"],
        rowPk: JSON.parse(String((row as { row_pk: string }).row_pk)) as unknown[],
      }));

    await pushDeltaToRemote(db, remote, entries);
    expect(deleteOrder).toEqual(["children", "parents"]);
    db.close();
  },
  );
});
