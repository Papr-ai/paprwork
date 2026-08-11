import { vi } from "vitest";
import type { Client } from "@libsql/client";

/** Turso mock that tracks tables, columns, and indexes for apply + verify paths. */
export function createMigrationMockRemote(
  initialColumns: Record<string, string[]> = {},
  initialIndexes: string[] = [],
): Client {
  const columnsByTable = new Map<string, Set<string>>(
    Object.entries(initialColumns).map(([table, cols]) => [table, new Set(cols)]),
  );
  const indexes = new Set(initialIndexes);
  const appliedMigrations = new Set<string>();

  return {
    execute: vi.fn(async (input: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof input === "string" ? input : input.sql;
      const args = typeof input === "string" ? [] : (input.args ?? []);

      if (sql.includes("CREATE TABLE IF NOT EXISTS _papr_schema_migrations")) {
        return { rows: [], columns: [], rowsAffected: 0 };
      }
      if (
        sql.includes("FROM sqlite_master") &&
        sql.includes("type='table'") &&
        !sql.includes("name = ?")
      ) {
        return {
          rows: [...columnsByTable.keys()].map((name) => ({ name })),
          columns: ["name"],
          rowsAffected: 0,
        };
      }
      if (sql.includes("type='table'") && sql.includes("name = ?")) {
        const name = String(args[0] ?? "");
        return {
          rows: columnsByTable.has(name) ? [{ 1: 1 }] : [],
          columns: [],
          rowsAffected: 0,
        };
      }
      if (sql.includes("type='index'") && sql.includes("name = ?")) {
        const name = String(args[0] ?? "");
        return {
          rows: indexes.has(name) ? [{ 1: 1 }] : [],
          columns: [],
          rowsAffected: 0,
        };
      }
      if (sql.startsWith("SELECT id FROM _papr_schema_migrations")) {
        return {
          rows: [...appliedMigrations].map((id) => ({ id })),
          columns: ["id"],
          rowsAffected: 0,
        };
      }
      if (sql.includes("FROM _papr_schema_migrations")) {
        return {
          rows: [...appliedMigrations].map((id) => ({ id, applied_at: "now" })),
          columns: ["id", "applied_at"],
          rowsAffected: 0,
        };
      }
      if (sql.startsWith("INSERT OR IGNORE INTO _papr_schema_migrations")) {
        appliedMigrations.add(String(args[0]));
        return { rows: [], columns: [], rowsAffected: 1 };
      }
      if (sql.startsWith("PRAGMA table_info(")) {
        const table = sql.match(/PRAGMA table_info\("([^"]+)"\)/)?.[1];
        const cols = table ? columnsByTable.get(table) : undefined;
        return {
          rows: [...(cols ?? [])].map((name) => ({
            name,
            type: "TEXT",
            pk: 0,
          })),
          columns: ["name", "type", "pk"],
          rowsAffected: 0,
        };
      }

      const createTableMatch =
        /^CREATE TABLE IF NOT EXISTS (?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(sql.trim());
      if (createTableMatch) {
        const table = createTableMatch[1] ?? createTableMatch[2] ?? createTableMatch[3];
        if (table && !columnsByTable.has(table)) {
          columnsByTable.set(table, new Set(["id"]));
        }
        return { rows: [], columns: [], rowsAffected: 0 };
      }

      const createIndexMatch =
        /^CREATE INDEX IF NOT EXISTS (?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(sql.trim());
      if (createIndexMatch) {
        const indexName =
          createIndexMatch[1] ?? createIndexMatch[2] ?? createIndexMatch[3];
        if (indexName) {
          indexes.add(indexName);
        }
        return { rows: [], columns: [], rowsAffected: 0 };
      }

      const addMatch =
        /^ALTER TABLE (?:"([^"]+)"|'([^']+)'|(\S+)) ADD COLUMN (?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(
          sql.trim(),
        );
      if (addMatch) {
        const table = addMatch[1] ?? addMatch[2] ?? addMatch[3];
        const column = addMatch[4] ?? addMatch[5] ?? addMatch[6];
        const cols = columnsByTable.get(table!) ?? new Set<string>();
        if (cols.has(column!)) {
          throw new Error(`duplicate column name: ${column}`);
        }
        cols.add(column!);
        columnsByTable.set(table!, cols);
        return { rows: [], columns: [], rowsAffected: 0 };
      }

      throw new Error(`Unexpected SQL in migration mock remote: ${sql.slice(0, 120)}`);
    }),
    close: vi.fn(),
  } as unknown as Client;
}
