import { describe, expect, it } from "vitest";

import {
  buildWorkspaceLogRowBatchEntries,
  chunkSyncLogWrites,
  maxSyncLogIdInBatch,
} from "../src/gateway/services/syncV3/workspaceLogBatchShip.js";
import { WORKSPACE_LOG_SHIP_BATCH_SIZE } from "../src/gateway/services/syncV3/WorkspaceLogClient.js";

describe("workspaceLogBatchShip", () => {
  it("chunks writes into batches of the configured size", () => {
    const writes = Array.from({ length: 1200 }, (_, i) => ({
      syncLogId: i + 1,
      sql: "INSERT INTO t VALUES (?)",
      params: [i],
    }));

    const batches = chunkSyncLogWrites(writes, WORKSPACE_LOG_SHIP_BATCH_SIZE);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(500);
    expect(batches[1]).toHaveLength(500);
    expect(batches[2]).toHaveLength(200);
  });

  it("builds row batch entries with app and db source metadata", () => {
    const entries = buildWorkspaceLogRowBatchEntries(
      [{ syncLogId: 7, sql: "DELETE FROM t WHERE id = ?", params: [1] }],
      "app-123",
      "primary",
    );

    expect(entries).toEqual([
      {
        kind: "row",
        dbSourceId: "primary",
        payload: {
          appId: "app-123",
          sql: "DELETE FROM t WHERE id = ?",
          params: [1],
        },
      },
    ]);
  });

  it("tracks max sync log id within a batch", () => {
    expect(
      maxSyncLogIdInBatch([
        { syncLogId: 10, sql: "x", params: [] },
        { syncLogId: 42, sql: "y", params: [] },
        { syncLogId: 11, sql: "z", params: [] },
      ]),
    ).toBe(42);
  });
});
