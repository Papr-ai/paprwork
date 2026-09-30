import { describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import {
  batchInsertLocalTableRows,
  deleteRemoteOrphanRowsByPk,
  REMOTE_INSERT_CHUNK_ROWS,
} from "../src/gateway/services/tursoBulkInsert.js";

describe("tursoBulkInsert", () => {
  it("uses multi-value INSERT with configured chunk size", async () => {
    const execute = vi.fn(async () => ({ rows: [], columns: [] }));
    const remote = { execute } as unknown as Client;
    const columns = [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "label", type: "TEXT", primaryKey: false },
    ];
    const rows = Array.from({ length: REMOTE_INSERT_CHUNK_ROWS + 10 }, (_, i) => [
      i + 1,
      `row-${i + 1}`,
    ]);

    await batchInsertLocalTableRows(remote, "widgets", columns, rows, "upsert");

    expect(execute).toHaveBeenCalledTimes(2);
    const firstCall = execute.mock.calls[0]![0] as { sql: string; args: unknown[] };
    expect(firstCall.sql).toContain("INSERT OR REPLACE INTO");
    expect(firstCall.sql.match(/\(\?, \?\)/g)?.length).toBe(REMOTE_INSERT_CHUNK_ROWS);
    expect(firstCall.args).toHaveLength(REMOTE_INSERT_CHUNK_ROWS * 2);

    const secondCall = execute.mock.calls[1]![0] as { sql: string; args: unknown[] };
    expect(secondCall.sql.match(/\(\?, \?\)/g)?.length).toBe(10);
  });

  it("deleteRemoteOrphanRowsByPk returns deleted primary keys", async () => {
    const execute = vi.fn(async (query: { sql: string } | string) => {
      const sql = typeof query === "string" ? query : query.sql;
      if (sql.includes("SELECT")) {
        return {
          rows: [{ pk: 1 }, { pk: 2 }, { pk: 99 }],
          columns: ["pk"],
        };
      }
      return { rows: [], columns: [] };
    });
    const remote = { execute } as unknown as Client;
    const deleted = await deleteRemoteOrphanRowsByPk(remote, "widgets", "id", [1, 2]);
    expect(deleted).toEqual([99]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
