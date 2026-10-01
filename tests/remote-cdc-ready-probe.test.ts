import { describe, expect, it, vi } from "vitest";
import { remoteInsertTriggersCoverSyncableTables } from "../src/gateway/services/tursoSyncLog.js";
import type { Client } from "@libsql/client";

function mockRemote(triggers: Set<string>): Client {
  return {
    execute: vi.fn(async (input: { sql: string; args: unknown[] }) => {
      const name = String(input.args[0] ?? "");
      if (input.sql.includes("type = 'trigger'") && triggers.has(name)) {
        return { rows: [{ 1: 1 }], columns: [], rowsAffected: 0, lastInsertRowid: 0n };
      }
      return { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };
    }),
  } as unknown as Client;
}

describe("remoteInsertTriggersCoverSyncableTables", () => {
  it("returns true when every syncable table has an insert trigger", async () => {
    const triggers = new Set(["_papr_tr_users_ai", "_papr_tr_jobs_ai"]);
    const remote = mockRemote(triggers);
    const ready = await remoteInsertTriggersCoverSyncableTables(remote, [
      "users",
      "jobs",
      "_papr_sync_log",
    ]);
    expect(ready).toBe(true);
  });

  it("returns false when a syncable table is missing its insert trigger", async () => {
    const triggers = new Set(["_papr_tr_users_ai"]);
    const remote = mockRemote(triggers);
    const ready = await remoteInsertTriggersCoverSyncableTables(remote, [
      "users",
      "jobs",
    ]);
    expect(ready).toBe(false);
  });

  it("returns true when there are no syncable user tables", async () => {
    const remote = mockRemote(new Set());
    const ready = await remoteInsertTriggersCoverSyncableTables(remote, []);
    expect(ready).toBe(true);
  });
});
