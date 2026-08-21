import { afterEach, describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import {
  clearWorkspaceLogCutoverStateForTests,
  getWorkspaceLogCutoverRecord,
} from "../src/gateway/services/syncV3/workspaceLogCutoverState.js";
import { computeDbSnapshotHash } from "../src/gateway/services/syncV3/workspaceLogGenesisCutover.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

describe("workspace log genesis cutover", () => {
  useIsolatedPaprWorkspace("workspace-log-genesis");

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearWorkspaceLogCutoverStateForTests();
  });

  test.skipIf(!canUseBetterSqlite)("computeDbSnapshotHash is stable for unchanged table", () => {
    const dbPath = path.join(process.env.PAPR_HOME!, "genesis-test.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    db.prepare("INSERT INTO items (name) VALUES (?)").run("alpha");
    db.close();

    const first = computeDbSnapshotHash(dbPath);
    const second = computeDbSnapshotHash(dbPath);
    expect(first?.tableCount).toBe(1);
    expect(first?.snapshotHash).toBe(second?.snapshotHash);
  });

  test.skipIf(!canUseBetterSqlite)("ensureWorkspaceLogGenesisForDb writes cutover record once", async () => {
    const dbPath = path.join(process.env.PAPR_HOME!, "genesis-once.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE metrics (id INTEGER PRIMARY KEY, value REAL)");
    db.close();

    vi.spyOn(
      await import("../src/gateway/services/syncV3/WorkspaceLogClient.js"),
      "writeWorkspaceLogGenesis",
    ).mockResolvedValue({
      replicaId: "j-genesis1",
      seq: 1,
      hlc: "2026-01-01T00:00:00Z",
      kind: "snapshot",
      dbSourceId: "primary",
      latencyMs: 12,
    });

    const { ensureWorkspaceLogGenesisForDb } = await import(
      "../src/gateway/services/syncV3/workspaceLogGenesisCutover.js"
    );

    expect(await ensureWorkspaceLogGenesisForDb("j-genesis1", dbPath, "primary")).toBe(
      true,
    );
    expect(await ensureWorkspaceLogGenesisForDb("j-genesis1", dbPath, "primary")).toBe(
      true,
    );

    const record = await getWorkspaceLogCutoverRecord("j-genesis1");
    expect(record?.genesisSeq).toBe(1);
    expect(record?.tableCount).toBe(1);
  });

  test.skipIf(!canUseBetterSqlite)(
    "runWorkspaceLogGenesisCutoverForAllLinkedSources completes new replicas",
    async () => {
      const dbPath = path.join(process.env.PAPR_HOME!, "batch-genesis.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT)");
      db.close();

      const tursoModule = await import("../src/gateway/services/tursoLinkedSources.js");
      vi.spyOn(tursoModule, "discoverTursoLinkedSources").mockResolvedValue([
        {
          appId: "app-batch",
          jobId: "de1a89d8-0000-4000-8000-000000000001",
          dbPath,
          alias: "primary",
        },
      ]);

      vi.spyOn(
        await import("../src/gateway/services/syncV3/WorkspaceLogClient.js"),
        "writeWorkspaceLogGenesis",
      ).mockResolvedValue({
        replicaId: "j-de1a89d8",
        seq: 10,
        hlc: "2026-01-01T00:00:00Z",
        kind: "snapshot",
        dbSourceId: "primary",
        latencyMs: 8,
      });

      const { runWorkspaceLogGenesisCutoverForAllLinkedSources } = await import(
        "../src/gateway/services/syncV3/workspaceLogGenesisCutover.js"
      );
      const summary = await runWorkspaceLogGenesisCutoverForAllLinkedSources();
      expect(summary.attempted).toBe(1);
      expect(summary.completed).toBe(1);
      expect(summary.failed).toBe(0);

      const record = await getWorkspaceLogCutoverRecord("j-de1a89d8");
      expect(record?.genesisSeq).toBe(10);
    },
  );
});
