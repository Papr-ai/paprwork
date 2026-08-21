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
    const pool = {
      write: vi.fn(async (_appId: string, _dbPath: string, sql: string, params?: unknown[]) => {
        writeCalls.push({ sql, params });
        return { changes: 1, lastInsertRowid: writeCalls.length };
      }),
      exec: vi.fn(async () => undefined),
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
    expect(writeCalls.length).toBe(rowEntries.length);

    const { getWorkspaceLogCursor } = await import(
      "../src/gateway/services/syncV3/workspaceLogCursor.js"
    );
    expect(await getWorkspaceLogCursor(fixture.replicaId)).toBe(fixture.nextCursor);
  });
});
