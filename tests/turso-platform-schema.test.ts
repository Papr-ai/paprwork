import { describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import {
  ensureRemotePlatformTursoSchema,
  REMOTE_SCHEMA_MIGRATIONS_TABLE,
  PLATFORM_SYNC_LOG_TABLE,
} from "../src/gateway/services/tursoPlatformSchema.js";
import { SYNC_META_TABLE } from "../src/gateway/services/tursoSyncBridgeCore.js";

function mockRemote(initialColumns: Record<string, string[]>): Client {
  const columns = { ...initialColumns };
  const executed: string[] = [];

  return {
    execute: vi.fn(async (sqlOrArgs: string | { sql: string; args?: unknown[] }) => {
      const sql =
        typeof sqlOrArgs === "string" ? sqlOrArgs : sqlOrArgs.sql;
      executed.push(sql);

      if (sql.includes("FROM sqlite_master")) {
        const match = /name = \?/.test(sql);
        const tableName = match
          ? String(
              typeof sqlOrArgs === "object" ? sqlOrArgs.args?.[0] : "",
            )
          : "";
        const exists = Object.prototype.hasOwnProperty.call(columns, tableName);
        return { rows: exists ? [{ 1: 1 }] : [] };
      }

      if (sql.startsWith("PRAGMA table_info")) {
        const tableMatch = /PRAGMA table_info\("([^"]+)"\)/.exec(sql);
        const table = tableMatch?.[1] ?? "";
        const cols = columns[table] ?? [];
        return {
          rows: cols.map((name, index) => ({ name, cid: index })),
        };
      }

      if (sql.startsWith("CREATE TABLE IF NOT EXISTS")) {
        const tableMatch = /CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(sql);
        const table = tableMatch?.[1];
        if (table && !columns[table]) {
          if (table === REMOTE_SCHEMA_MIGRATIONS_TABLE) {
            columns[table] = ["id", "applied_at", "source", "content_hash"];
          } else if (table === PLATFORM_SYNC_LOG_TABLE) {
            columns[table] = [
              "id",
              "table_name",
              "op",
              "row_pk",
              "changed_at",
            ];
          } else if (table === SYNC_META_TABLE) {
            columns[table] = ["id", "version", "updated_at", "compacted_through_id"];
          } else {
            columns[table] = [];
          }
        }
        return { rows: [] };
      }

      if (sql.includes("ADD COLUMN")) {
        const tableMatch = /ALTER TABLE "([^"]+)"/.exec(sql);
        const colMatch = /ADD COLUMN (\w+)/.exec(sql);
        const table = tableMatch?.[1];
        const col = colMatch?.[1];
        if (table && col) {
          columns[table] = [...(columns[table] ?? []), col];
        }
        return { rows: [] };
      }

      return { rows: [] };
    }),
  } as unknown as Client;
}

describe("tursoPlatformSchema", () => {
  it("adds content_hash to legacy _papr_schema_migrations", async () => {
    const remote = mockRemote({
      [REMOTE_SCHEMA_MIGRATIONS_TABLE]: ["id", "applied_at", "source"],
    });

    await ensureRemotePlatformTursoSchema(remote);

    const execute = remote.execute as ReturnType<typeof vi.fn>;
    expect(
      execute.mock.calls.some(([arg]) =>
        String(typeof arg === "string" ? arg : arg.sql).includes(
          'ADD COLUMN content_hash',
        ),
      ),
    ).toBe(true);
  });

  it("adds changed_at to legacy _papr_sync_log", async () => {
    const remote = mockRemote({
      [PLATFORM_SYNC_LOG_TABLE]: ["id", "table_name", "op", "row_pk"],
    });

    await ensureRemotePlatformTursoSchema(remote);

    const execute = remote.execute as ReturnType<typeof vi.fn>;
    expect(
      execute.mock.calls.some(([arg]) =>
        String(typeof arg === "string" ? arg : arg.sql).includes(
          'ADD COLUMN changed_at',
        ),
      ),
    ).toBe(true);
  });
});
