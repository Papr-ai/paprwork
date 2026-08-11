import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Client } from "@libsql/client";
import {
  computeRemoteTableFingerprint,
  findTablesWithFingerprintDrift,
  reconcileDriftedTablesFromRemote,
} from "../src/gateway/services/tursoPullReconcile.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

function mockRemoteWithTables(
  tables: Record<string, { columns: Array<{ name: string; type: string; pk?: number }>; rows: Record<string, unknown>[] }>,
): Client {
  const execute = async (query: string | { sql: string; args?: unknown[] }) => {
    const sql = typeof query === "string" ? query : query.sql;
    const args = typeof query === "string" ? [] : (query.args ?? []);

    if (sql.includes("sqlite_master") && sql.includes("name = ?")) {
      const name = args[0] as string;
      return { rows: tables[name] ? [{ ok: 1 }] : [], columns: [] };
    }

    if (sql.includes("PRAGMA table_info") || sql.includes("PRAGMA foreign_key_list")) {
      const match = sql.match(/PRAGMA table_info\(([^)]+)\)/);
      const tableName = match?.[1]?.replace(/"/g, "") ?? "";
      const table = tables[tableName];
      if (!table) {
        return { rows: [], columns: [] };
      }
      return {
        rows: table.columns.map((col) => ({
          name: col.name,
          type: col.type,
          pk: col.pk ?? 0,
        })),
        columns: [],
      };
    }

    if (sql.includes("PRAGMA foreign_key_list")) {
      return { rows: [], columns: [] };
    }

    if (sql.includes("SELECT sql FROM sqlite_master")) {
      return { rows: [{ sql: null }], columns: [] };
    }

    const selectMatch = sql.match(/FROM "([^"]+)"/);
    const tableName = selectMatch?.[1];
    const table = tableName ? tables[tableName] : undefined;
    if (!table) {
      return { rows: [], columns: [] };
    }

    if (sql.includes("COUNT(*)")) {
      return { rows: [{ count: table.rows.length }], columns: [] };
    }

    if (sql.includes("ORDER BY rowid")) {
      const limit = Number(args[0] ?? table.rows.length);
      const offset = Number(args[1] ?? 0);
      const slice = table.rows.slice(offset, offset + limit);
      return { rows: slice, columns: [] };
    }

    if (sql.includes("LIMIT ? OFFSET ?")) {
      const limit = Number(args[0] ?? table.rows.length);
      const offset = Number(args[1] ?? 0);
      const slice = table.rows.slice(offset, offset + limit);
      return { rows: slice, columns: [] };
    }

    return { rows: [], columns: [] };
  };

  return { execute } as unknown as Client;
}

describe("tursoPullReconcile", () => {
  it.skipIf(!canUseBetterSqlite)(
    "findTablesWithFingerprintDrift detects child table mismatch",
    async () => {
      const localDb = new Database(":memory:");
      localDb.exec(`
        CREATE TABLE audits (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE audit_modules (id TEXT PRIMARY KEY, audit_id TEXT, name TEXT);
        INSERT INTO audits (id, status) VALUES ('a1', 'complete');
      `);

      const remote = mockRemoteWithTables({
        audits: {
          columns: [
            { name: "id", type: "TEXT", pk: 1 },
            { name: "status", type: "TEXT" },
          ],
          rows: [{ id: "a1", status: "complete" }],
        },
        audit_modules: {
          columns: [
            { name: "id", type: "TEXT", pk: 1 },
            { name: "audit_id", type: "TEXT" },
            { name: "name", type: "TEXT" },
          ],
          rows: [
            { id: "m1", audit_id: "a1", name: "Security" },
            { id: "m2", audit_id: "a1", name: "GTM" },
          ],
        },
      });

      const drifted = await findTablesWithFingerprintDrift(
        localDb,
        remote,
        ["audits", "audit_modules"],
      );

      expect(drifted).toEqual(["audit_modules"]);
      localDb.close();
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "reconcileDriftedTablesFromRemote hydrates missing child rows",
    async () => {
      const localDb = new Database(":memory:");
      localDb.exec(`
        CREATE TABLE audits (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE audit_modules (id TEXT PRIMARY KEY, audit_id TEXT, name TEXT);
        INSERT INTO audits (id, status) VALUES ('a1', 'complete');
      `);

      const remote = mockRemoteWithTables({
        audit_modules: {
          columns: [
            { name: "id", type: "TEXT", pk: 1 },
            { name: "audit_id", type: "TEXT" },
            { name: "name", type: "TEXT" },
          ],
          rows: [{ id: "m1", audit_id: "a1", name: "Security" }],
        },
      });

      await reconcileDriftedTablesFromRemote(localDb, remote, ["audit_modules"]);

      const count = localDb
        .prepare("SELECT COUNT(*) AS c FROM audit_modules")
        .get() as { c: number };
      expect(count.c).toBe(1);

      const row = localDb
        .prepare("SELECT name FROM audit_modules WHERE id = 'm1'")
        .get() as { name: string };
      expect(row.name).toBe("Security");
      localDb.close();
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "computeRemoteTableFingerprint matches local fingerprint for same data",
    async () => {
      const localDb = new Database(":memory:");
      localDb.exec(`
        CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
        INSERT INTO items (id, label) VALUES (1, 'alpha');
      `);

      const remote = mockRemoteWithTables({
        items: {
          columns: [
            { name: "id", type: "INTEGER", pk: 1 },
            { name: "label", type: "TEXT" },
          ],
          rows: [{ id: 1, label: "alpha" }],
        },
      });

      const { computeTableFingerprint } = await import(
        "../src/gateway/services/tursoTableFingerprint.js"
      );
      const localFp = computeTableFingerprint(localDb, "items");
      const remoteFp = await computeRemoteTableFingerprint(remote, "items");
      expect(remoteFp).toBe(localFp);
      localDb.close();
    },
  );
});
