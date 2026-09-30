import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { DbQueryPool } from "../src/gateway/services/DbQueryPool.js";
import type {
  WorkspaceLogEntry,
  WorkspaceLogSinceResponse,
} from "../src/core/types/workspaceLog.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/workspace-log",
);

function loadFixture(name: string): WorkspaceLogSinceResponse {
  const raw = readFileSync(path.join(FIXTURE_DIR, name), "utf8");
  const parsed = JSON.parse(raw) as WorkspaceLogSinceResponse & {
    description?: string;
  };
  expect(parsed.replicaId).toBeTruthy();
  expect(Array.isArray(parsed.entries)).toBe(true);
  return parsed;
}

function listRowEntries(entries: WorkspaceLogEntry[]): WorkspaceLogEntry[] {
  return entries.filter((entry) => entry.kind === "row");
}

describe("workspace log replay fixtures", () => {
  useIsolatedPaprWorkspace("workspace-log-replay-fixtures");

  afterEach(async () => {
    vi.restoreAllMocks();
    const { clearWorkspaceLogCursorsForTests } = await import(
      "../src/gateway/services/syncV3/workspaceLogCursor.js"
    );
    await clearWorkspaceLogCursorsForTests();
  });

  test("fixture files are present and well-formed", () => {
    const files = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const fixture = loadFixture(file);
      expect(fixture.entries.length).toBeGreaterThan(0);
    }
  });

  test.each([
    "prod-sample-1.json",
    "prod-sample-2.json",
    "prod-sample-3.json",
  ])("replays row entries from %s", async (fixtureName) => {
    const fixture = loadFixture(fixtureName);
    const rowEntries = listRowEntries(fixture.entries);
    if (rowEntries.length === 0) {
      return;
    }

    const writeCalls: Array<{ sql: string; params?: unknown[] }> = [];
    const write = vi.fn(async (_appId: string, _dbPath: string, sql: string, params?: unknown[]) => {
      writeCalls.push({ sql, params });
      return { changes: 1, lastInsertRowid: writeCalls.length };
    });
    const pool = {
      write,
      writeBatch: vi.fn(
        async (
          appId: string,
          dbPath: string,
          statements: Array<{ sql: string; params?: unknown[] }>,
        ) => {
          const results = [];
          for (const statement of statements) {
            if (statement.sql.includes("PRAGMA foreign_keys")) {
              continue;
            }
            results.push(await write(appId, dbPath, statement.sql, statement.params));
          }
          return results;
        },
      ),
      exec: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [], columns: [], count: 0 })),
    } as unknown as DbQueryPool;

    const source = {
      alias: "primary",
      jobId: fixture.replicaId.replace(/^j-/, "job-"),
      dbPath: "/tmp/fixture-replay.db",
      tables: ["items"],
    };

    vi.spyOn(
      await import("../src/gateway/services/syncV3/WorkspaceLogClient.js"),
      "readWorkspaceLogSince",
    ).mockResolvedValue(fixture);

    const { materializeWorkspaceLogSince } = await import(
      "../src/gateway/services/syncV3/LogMaterializer.js"
    );
    const applied = await materializeWorkspaceLogSince(pool, fixture.replicaId, source);

    expect(applied).toBe(fixture.entries.length);
    const dataWrites = writeCalls.filter((call) => !call.sql.includes("_papr_materialized"));
    expect(dataWrites.length).toBe(rowEntries.length);

    const { getWorkspaceLogCursor } = await import(
      "../src/gateway/services/syncV3/workspaceLogCursor.js"
    );
    expect(await getWorkspaceLogCursor(fixture.replicaId)).toBe(fixture.nextCursor);
  });
});
