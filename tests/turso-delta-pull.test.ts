import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { Client } from "@libsql/client";
import {
  compactSyncLogEntries,
  ensureLocalTableSyncTriggers,
  type SyncLogEntry,
} from "../src/gateway/services/tursoSyncLog.js";
import { applyRemoteSyncLogToLocal } from "../src/gateway/services/tursoDeltaPull.js";
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

describe("applyRemoteSyncLogToLocal batching", () => {
  it.skipIf(!canUseBetterSqlite)(
    "uses batched remote fetch and chunked local upserts",
    async () => {
      const remoteRows = new Map<number, { id: number; label: string }>();
      for (let i = 1; i <= REMOTE_INSERT_CHUNK_ROWS + 10; i += 1) {
        remoteRows.set(i, { id: i, label: `remote-${i}` });
      }

      const execute = vi.fn(async (query: string | { sql: string; args?: unknown[] }) => {
        const sql = typeof query === "string" ? query : query.sql;
        const args = typeof query === "string" ? [] : (query.args ?? []);

        if (sql.includes("PRAGMA table_info")) {
          return {
            rows: [
              { name: "id", type: "INTEGER", pk: 1 },
              { name: "label", type: "TEXT", pk: 0 },
            ],
            columns: [],
          };
        }

        if (sql.includes("WHERE") && sql.includes("IN (")) {
          const pks = args as number[];
          const rows = pks
            .filter((pk) => remoteRows.has(pk))
            .map((pk) => remoteRows.get(pk)!);
          return { rows, columns: [] };
        }

        if (sql.includes("SELECT") && sql.includes("WHERE") && args.length > 0) {
          const pk = args[0] as number;
          const row = remoteRows.get(pk);
          return { rows: row ? [row] : [], columns: [] };
        }

        return { rows: [], columns: [] };
      });
      const remote = { execute } as unknown as Client;

      const localDb = new Database(":memory:");
      localDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY,
          label TEXT NOT NULL
        );
      `);
      ensureLocalTableSyncTriggers(localDb, "events");

      const entries: SyncLogEntry[] = [];
      for (let i = 1; i <= REMOTE_INSERT_CHUNK_ROWS + 10; i += 1) {
        entries.push({
          id: i,
          tableName: "events",
          op: "insert",
          rowPk: [i],
        });
      }
      const compacted = compactSyncLogEntries(entries);
      await applyRemoteSyncLogToLocal(localDb, remote, compacted);

      const count = localDb
        .prepare("SELECT COUNT(*) AS c FROM events")
        .get() as { c: number };
      expect(count.c).toBe(REMOTE_INSERT_CHUNK_ROWS + 10);

      const batchedFetchCalls = execute.mock.calls.filter((call) => {
        const sql = typeof call[0] === "string" ? call[0] : call[0].sql;
        return sql.includes("IN (");
      });
      expect(batchedFetchCalls.length).toBeGreaterThan(1);

      localDb.close();
    },
  );

  it.skipIf(!canUseBetterSqlite)("applies batched local deletes for remote tombstones", async () => {
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

    const localDb = new Database(":memory:");
    localDb.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL
      );
    `);
    ensureLocalTableSyncTriggers(localDb, "events");
    localDb.prepare("INSERT INTO events (id, label) VALUES (?, ?)").run(1, "keep");
    localDb.prepare("INSERT INTO events (id, label) VALUES (?, ?)").run(2, "drop-me");
    localDb.prepare("INSERT INTO events (id, label) VALUES (?, ?)").run(3, "drop-me-too");

    const entries: SyncLogEntry[] = [
      { id: 1, tableName: "events", op: "delete", rowPk: [2] },
      { id: 2, tableName: "events", op: "delete", rowPk: [3] },
    ];
    await applyRemoteSyncLogToLocal(localDb, remote, entries);

    const remaining = localDb
      .prepare("SELECT id FROM events ORDER BY id")
      .all() as Array<{ id: number }>;
    expect(remaining.map((row) => row.id)).toEqual([1]);
    localDb.close();
  });
});
