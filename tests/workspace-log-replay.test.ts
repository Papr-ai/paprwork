import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { DbQueryPool } from "../src/gateway/services/DbQueryPool.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import { hashBlobContent } from "../src/gateway/services/syncV3/computeParentHash.js";

describe("workspace log replay", () => {
  useIsolatedPaprWorkspace("workspace-log-replay");

  afterEach(async () => {
    vi.restoreAllMocks();
    const { clearWorkspaceLogCursorsForTests } = await import(
      "../src/gateway/services/syncV3/workspaceLogCursor.js"
    );
    await clearWorkspaceLogCursorsForTests();
  });

  test("materializeWorkspaceLogSince applies row entries in order", async () => {
    const writeCalls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      write: vi.fn(async (_appId: string, _dbPath: string, sql: string, params?: unknown[]) => {
        writeCalls.push({ sql, params });
        return { changes: 1, lastInsertRowid: writeCalls.length };
      }),
      exec: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [], columns: [], count: 0 })),
    } as unknown as DbQueryPool;

    const source = {
      alias: "primary",
      jobId: "job-log-test",
      dbPath: "/tmp/data.db",
      tables: ["items"],
    };

    vi.spyOn(
      await import("../src/gateway/services/syncV3/WorkspaceLogClient.js"),
      "readWorkspaceLogSince",
    ).mockResolvedValue({
      replicaId: "j-logtest1",
      cursor: 0,
      nextCursor: 2,
      hasMore: false,
      entries: [
        {
          seq: 1,
          hlc: "2026-01-01T00:00:00Z",
          kind: "row",
          dbSourceId: "primary",
          payload: {
            appId: "app-1",
            sql: "INSERT INTO items (name) VALUES (?)",
            params: ["alpha"],
          },
        },
        {
          seq: 2,
          hlc: "2026-01-01T00:00:01Z",
          kind: "row",
          dbSourceId: "primary",
          payload: {
            appId: "app-1",
            sql: "INSERT INTO items (name) VALUES (?)",
            params: ["beta"],
          },
        },
      ],
    });

    const { materializeWorkspaceLogSince } = await import(
      "../src/gateway/services/syncV3/LogMaterializer.js"
    );
    const applied = await materializeWorkspaceLogSince(pool, "j-logtest1", source);
    expect(applied).toBe(2);
    expect(
      writeCalls
        .filter((call) => !call.sql.includes("_papr_materialized"))
        .map((call) => call.params?.[0]),
    ).toEqual(["alpha", "beta"]);

    const { getWorkspaceLogCursor } = await import(
      "../src/gateway/services/syncV3/workspaceLogCursor.js"
    );
    expect(await getWorkspaceLogCursor("j-logtest1")).toBe(2);
  });

  test("materializeWorkspaceLogSince skips already-materialized seq on replay", async () => {
    const writeCalls: Array<{ sql: string; params?: unknown[] }> = [];
    const materialized = new Set<string>();

    const pool = {
      write: vi.fn(async (_appId: string, _dbPath: string, sql: string, params?: unknown[]) => {
        if (sql.includes("_papr_materialized")) {
          const key = `${params?.[0]}:${params?.[1]}`;
          materialized.add(key);
          return { changes: 1, lastInsertRowid: 1 };
        }
        writeCalls.push({ sql, params });
        return { changes: 1, lastInsertRowid: writeCalls.length };
      }),
      exec: vi.fn(async () => undefined),
      query: vi.fn(async (_appId: string, _dbPath: string, sql: string, params?: unknown[]) => {
        if (sql.includes("_papr_materialized")) {
          const key = `${params?.[0]}:${params?.[1]}`;
          return {
            rows: materialized.has(key) ? [{ ok: 1 }] : [],
            columns: ["ok"],
            count: materialized.has(key) ? 1 : 0,
          };
        }
        return { rows: [], columns: [], count: 0 };
      }),
    } as unknown as DbQueryPool;

    const source = {
      alias: "primary",
      jobId: "job-log-test",
      dbPath: "/tmp/data.db",
      tables: ["items"],
    };

    const logPage = {
      replicaId: "j-logtest1",
      cursor: 0,
      nextCursor: 1,
      hasMore: false,
      entries: [
        {
          seq: 1,
          hlc: "2026-01-01T00:00:00Z",
          kind: "row" as const,
          dbSourceId: "primary",
          payload: {
            appId: "app-1",
            sql: "INSERT INTO items (name) VALUES (?)",
            params: ["once"],
          },
        },
      ],
    };

    vi.spyOn(
      await import("../src/gateway/services/syncV3/WorkspaceLogClient.js"),
      "readWorkspaceLogSince",
    ).mockResolvedValue(logPage);

    const cursorMod = await import("../src/gateway/services/syncV3/workspaceLogCursor.js");
    vi.spyOn(cursorMod, "getWorkspaceLogCursor").mockResolvedValue(0);

    const { materializeWorkspaceLogSince } = await import(
      "../src/gateway/services/syncV3/LogMaterializer.js"
    );

    const first = await materializeWorkspaceLogSince(pool, "j-logtest1", source);
    expect(first).toBe(1);
    expect(writeCalls).toHaveLength(1);

    const second = await materializeWorkspaceLogSince(pool, "j-logtest1", source);
    expect(second).toBe(1);
    expect(writeCalls).toHaveLength(1);
  });

  test("materializeWorkspaceLogSince skips row ops for dropped tables", async () => {
    let canUseBetterSqlite = false;
    try {
      const Database = (await import("better-sqlite3")).default;
      const probe = new Database(":memory:");
      probe.close();
      canUseBetterSqlite = true;
    } catch {
      canUseBetterSqlite = false;
    }

    if (!canUseBetterSqlite) {
      return;
    }

    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.join(process.env.PAPR_HOME!, "replay-skip-missing.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE person_label (id TEXT PRIMARY KEY, tag TEXT)");
    db.close();

    const writeCalls: string[] = [];
    const pool = {
      write: vi.fn(async (_appId: string, _dbPath: string, sql: string) => {
        writeCalls.push(sql);
        return { changes: 1, lastInsertRowid: 1 };
      }),
      exec: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [], columns: [], count: 0 })),
    } as unknown as DbQueryPool;

    const source = {
      alias: "primary",
      jobId: "job-skip",
      dbPath,
      tables: ["person_label"],
    };

    vi.spyOn(
      await import("../src/gateway/services/syncV3/WorkspaceLogClient.js"),
      "readWorkspaceLogSince",
    ).mockResolvedValue({
      replicaId: "j-skip1",
      cursor: 0,
      nextCursor: 1,
      hasMore: false,
      entries: [
        {
          seq: 1,
          hlc: "2026-01-01T00:00:00Z",
          kind: "row",
          dbSourceId: "primary",
          payload: {
            appId: "app-1",
            sql: "INSERT INTO person_tags (id, tag) VALUES (?, ?)",
            params: ["1", "foo"],
          },
        },
      ],
    });

    const { materializeWorkspaceLogSince } = await import(
      "../src/gateway/services/syncV3/LogMaterializer.js"
    );
    const applied = await materializeWorkspaceLogSince(pool, "j-skip1", source);
    expect(applied).toBe(1);
    expect(writeCalls).toHaveLength(0);
  });

  test("materializeWorkspaceLogSince skips row ops when SQLite reports missing table", async () => {
    let canUseBetterSqlite = false;
    try {
      const Database = (await import("better-sqlite3")).default;
      const probe = new Database(":memory:");
      probe.close();
      canUseBetterSqlite = true;
    } catch {
      canUseBetterSqlite = false;
    }

    if (!canUseBetterSqlite) {
      return;
    }

    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.join(process.env.PAPR_HOME!, "replay-sqlite-skip.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE person_label (id TEXT PRIMARY KEY, tag TEXT)");
    db.close();

    const pool = {
      write: vi.fn(async () => {
        throw new Error("no such table: person_tags");
      }),
      exec: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [], columns: [], count: 0 })),
    } as unknown as DbQueryPool;

    const source = {
      alias: "primary",
      jobId: "job-sqlite-skip",
      dbPath,
      tables: ["person_label"],
    };

    vi.spyOn(
      await import("../src/gateway/services/syncV3/WorkspaceLogClient.js"),
      "readWorkspaceLogSince",
    ).mockResolvedValue({
      replicaId: "j-sqlite-skip",
      cursor: 0,
      nextCursor: 1,
      hasMore: false,
      entries: [
        {
          seq: 9,
          hlc: "2026-01-01T00:00:00Z",
          kind: "row",
          dbSourceId: "primary",
          payload: {
            appId: "app-1",
            sql: "WITH cte AS (SELECT 1) INSERT INTO person_tags (id) VALUES ('x')",
            params: [],
          },
        },
      ],
    });

    const { materializeWorkspaceLogSince } = await import(
      "../src/gateway/services/syncV3/LogMaterializer.js"
    );
    await expect(
      materializeWorkspaceLogSince(pool, "j-sqlite-skip", source),
    ).resolves.toBe(1);
    expect(pool.write).toHaveBeenCalledTimes(1);
  });
});

describe("OID cache crash replay", () => {
  useIsolatedPaprWorkspace("oid-crash-replay");

  afterEach(async () => {
    const { clearOidCacheForTests } = await import(
      "../src/gateway/services/syncV3/OidCache.js"
    );
    const { clearSyncOutboxForTests } = await import(
      "../src/gateway/services/syncV3/SyncOutbox.js"
    );
    await clearOidCacheForTests();
    await clearSyncOutboxForTests();
  });

  test("pending outbox survives reload and refreshes parent hashes from cache", async () => {
    const paprDir = process.env.PAPR_HOME!;
    const appId = "crash-replay-app";
    const appDir = path.join(paprDir, "apps", appId);
    await fs.mkdir(appDir, { recursive: true });
    const content = "<html>v2</html>";
    await fs.writeFile(path.join(appDir, "index.html"), content, "utf8");

    const oldOid = hashBlobContent("<html>v1</html>");
    const { applyAckedBlobOids } = await import(
      "../src/gateway/services/syncV3/OidCache.js"
    );
    await applyAckedBlobOids(appId, [{ path: "index.html", blobOid: oldOid }]);

    const { appendOutboxEntry, listPendingOutboxEntries } = await import(
      "../src/gateway/services/syncV3/SyncOutbox.js"
    );
    const { refreshOpParentHashes } = await import(
      "../src/gateway/services/syncV3/collectAppOpFiles.js"
    );

    await appendOutboxEntry({
      appId,
      files: [{ path: "index.html", content, parentHash: "stale" }],
      author: "desktop",
      message: "sync after crash",
    });

    const pending = await listPendingOutboxEntries(appId);
    expect(pending).toHaveLength(1);

    const refreshed = await refreshOpParentHashes(appId, pending[0]!.files);
    expect(refreshed[0]?.path).toBe("index.html");
    expect(refreshed[0]?.parentHash).toBe(oldOid);
  });
});
