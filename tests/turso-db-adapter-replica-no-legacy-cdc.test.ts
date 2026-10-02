/**
 * Regression: cloud mini-app writes must not install legacy CDC columns/triggers
 * on Plan A replica databases.
 *
 * Before the fix, the first cloud write to a replica-mode database ALTERed every
 * user table on the Turso primary (adding _papr_created_at / _papr_updated_at /
 * _papr_row_version). Turso Sync replicated the new columns down to every desktop,
 * and positional `INSERT INTO t VALUES (...)` from jobs started failing with
 * "table t has 17 columns but 14 values were supplied".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import type { TursoCredentialsProvider } from "../src/gateway/services/appRuntime/types.js";

let syncMode: "replica" | "legacy" | undefined = "replica";

vi.mock("../src/gateway/services/DatabaseRegistryService.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabaseRegistryService: vi.fn(() => ({
    getRecordForSource: () => ({ dbId: "db-1", syncMode }),
  })),
  tursoNameForRecord: vi.fn(),
}));

import { TursoDbAdapter } from "../src/gateway/services/appRuntime/TursoDbAdapter.js";

const source: AppDataSource = {
  id: "db-1:econ",
  type: "sqlite",
  dbId: "db-1",
  alias: "econ",
  dbPath: "/tmp/data.db",
  tables: [],
  linkedAt: new Date().toISOString(),
};

function mockRemote(): { client: Client; sql: string[] } {
  const sql: string[] = [];
  const client = {
    execute: vi.fn(async (input: string | { sql: string }) => {
      const text = typeof input === "string" ? input : input.sql;
      sql.push(text);
      if (/FROM sqlite_master/i.test(text) && /type\s*=\s*'table'/i.test(text)) {
        return { rows: [{ name: "usage_orgs" }], columns: ["name"], rowsAffected: 0, lastInsertRowid: 0n };
      }
      if (/PRAGMA table_info/i.test(text)) {
        return {
          rows: [{ name: "org_id", type: "TEXT", pk: 1 }, { name: "credits", type: "REAL", pk: 0 }],
          columns: [],
          rowsAffected: 0,
          lastInsertRowid: 0n,
        };
      }
      return { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };
    }),
    batch: vi.fn(async () => []),
  } as unknown as Client;
  return { client, sql };
}

type Prep = (client: Client, key: string, rev: string | null, src?: AppDataSource) => Promise<void>;

function prep(adapter: TursoDbAdapter): Prep {
  const fn = (adapter as unknown as { ensureRemoteChangeLogReady: Prep }).ensureRemoteChangeLogReady;
  return fn.bind(adapter);
}

describe("TursoDbAdapter remote change-log prep", () => {
  afterEach(() => {
    syncMode = "replica";
    vi.clearAllMocks();
  });

  it("does not ALTER user tables or add triggers on replica-mode databases", async () => {
    const adapter = new TursoDbAdapter({} as TursoCredentialsProvider);
    const { client, sql } = mockRemote();

    await prep(adapter)(client, "k-replica", null, source);

    // Platform bookkeeping tables (_papr_sync_meta etc.) may be created/altered;
    // user tables must not be touched.
    const touchesUserTable = (s: string) => /usage_orgs/i.test(s) && /ALTER TABLE|CREATE TRIGGER/i.test(s);
    expect(sql.some(touchesUserTable)).toBe(false);
    expect(sql.some((s) => /CREATE TRIGGER/i.test(s))).toBe(false);
    // Shared bookkeeping (_papr_sync_meta etc.) is still created.
    expect(sql.some((s) => /CREATE TABLE IF NOT EXISTS/i.test(s))).toBe(true);
  });

  it("still installs legacy CDC triggers for legacy databases", async () => {
    syncMode = "legacy";
    const adapter = new TursoDbAdapter({} as TursoCredentialsProvider);
    const { client, sql } = mockRemote();

    await prep(adapter)(client, "k-legacy", null, source);

    expect(sql.some((s) => /CREATE TRIGGER/i.test(s))).toBe(true);
  });
});
