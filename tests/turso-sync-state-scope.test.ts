import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isTursoStateDbPathInWorkspace,
  listDbDirtySyncKeys,
  listDbDirtySyncKeysForApp,
  loadTursoSyncState,
  markDbDirty,
  pruneTursoSyncStateForWorkspace,
  saveTursoSyncState,
} from "../src/gateway/services/tursoSyncState.js";

describe("turso sync state workspace scoping", () => {
  it("isTursoStateDbPathInWorkspace matches paths under paprDir only", () => {
    const workspace = path.join(os.tmpdir(), "papr-ws-a");
    const other = path.join(os.tmpdir(), "papr-ws-b");
    const inWs = path.join(workspace, "data", "databases", "demo", "data.db");
    const outWs = path.join(other, "data", "databases", "demo", "data.db");

    expect(isTursoStateDbPathInWorkspace(inWs, workspace)).toBe(true);
    expect(isTursoStateDbPathInWorkspace(outWs, workspace)).toBe(false);
  });

  it("listDbDirtySyncKeys ignores dirty flags for other workspaces", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "papr-scope-ws-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "papr-scope-other-"));
    const inDbDir = path.join(workspace, "data", "databases", "demo");
    const outDbDir = path.join(other, "data", "databases", "demo");
    fs.mkdirSync(inDbDir, { recursive: true });
    fs.mkdirSync(outDbDir, { recursive: true });
    const inDb = path.join(inDbDir, "data.db");
    const outDb = path.join(outDbDir, "data.db");
    fs.writeFileSync(inDb, "sqlite");
    fs.writeFileSync(outDb, "sqlite");

    markDbDirty("db-in", inDb, workspace);
    saveTursoSyncState(
      {
        jobs: {
          ...loadTursoSyncState(workspace).jobs,
          "db-out": {
            dbPath: outDb,
            lastPushAt: new Date(0).toISOString(),
            dirtyFlag: true,
            dirtyFlagAt: new Date().toISOString(),
          },
        },
      },
      workspace,
    );

    expect(listDbDirtySyncKeys(workspace)).toEqual(["db-in"]);

    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("pruneTursoSyncStateForWorkspace removes cross-workspace rows", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "papr-prune-ws-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "papr-prune-other-"));
    const inDb = path.join(workspace, "data", "databases", "demo", "data.db");
    const outDb = path.join(other, "data", "databases", "demo", "data.db");
    fs.mkdirSync(path.dirname(inDb), { recursive: true });
    fs.mkdirSync(path.dirname(outDb), { recursive: true });
    fs.writeFileSync(inDb, "sqlite");
    fs.writeFileSync(outDb, "sqlite");

    saveTursoSyncState(
      {
        jobs: {
          "db-in": {
            dbPath: inDb,
            lastPushAt: new Date(0).toISOString(),
            dirtyFlag: true,
          },
          "db-out": {
            dbPath: outDb,
            lastPushAt: new Date(0).toISOString(),
            dirtyFlag: true,
          },
        },
      },
      workspace,
    );

    const pruned = pruneTursoSyncStateForWorkspace(workspace);
    expect(pruned).toBeGreaterThan(0);

    const state = loadTursoSyncState(workspace);
    expect(state.jobs["db-out"]).toBeUndefined();
    expect(state.jobs["db-in"]).toBeDefined();

    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("prune in one workspace does not delete another workspace sync state file", () => {
    const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), "papr-prune-a-"));
    const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), "papr-prune-b-"));
    const dbInA = path.join(workspaceA, "data", "databases", "a", "data.db");
    const dbInB = path.join(workspaceB, "data", "databases", "b", "data.db");
    fs.mkdirSync(path.dirname(dbInA), { recursive: true });
    fs.mkdirSync(path.dirname(dbInB), { recursive: true });
    fs.writeFileSync(dbInA, "sqlite");
    fs.writeFileSync(dbInB, "sqlite");

    saveTursoSyncState(
      {
        jobs: {
          "db-a": {
            dbPath: dbInA,
            lastPushAt: new Date(0).toISOString(),
            dirtyFlag: true,
          },
          "db-b-leaked": {
            dbPath: dbInB,
            lastPushAt: new Date(0).toISOString(),
            dirtyFlag: true,
          },
        },
      },
      workspaceA,
    );
    saveTursoSyncState(
      {
        jobs: {
          "db-b": {
            dbPath: dbInB,
            lastPushAt: new Date(0).toISOString(),
            dirtyFlag: true,
          },
        },
      },
      workspaceB,
    );

    pruneTursoSyncStateForWorkspace(workspaceA);

    expect(loadTursoSyncState(workspaceA).jobs["db-b-leaked"]).toBeUndefined();
    expect(loadTursoSyncState(workspaceA).jobs["db-a"]).toBeDefined();
    expect(loadTursoSyncState(workspaceB).jobs["db-b"]).toBeDefined();
    expect(listDbDirtySyncKeys(workspaceB)).toEqual(["db-b"]);

    fs.rmSync(workspaceA, { recursive: true, force: true });
    fs.rmSync(workspaceB, { recursive: true, force: true });
  });

  it("markDbDirty ignores DB paths outside active workspace", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "papr-write-guard-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "papr-write-guard-other-"));
    const inDb = path.join(workspace, "data", "databases", "in", "data.db");
    const outDb = path.join(other, "data", "databases", "out", "data.db");
    fs.mkdirSync(path.dirname(inDb), { recursive: true });
    fs.mkdirSync(path.dirname(outDb), { recursive: true });
    fs.writeFileSync(inDb, "sqlite");
    fs.writeFileSync(outDb, "sqlite");

    markDbDirty("db-in", inDb, workspace);
    markDbDirty("db-out", outDb, workspace);

    const state = loadTursoSyncState(workspace);
    expect(state.jobs["db-in"]).toBeDefined();
    expect(state.jobs["db-out"]).toBeUndefined();

    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("listDbDirtySyncKeysForApp filters to linked sync keys", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "papr-app-scope-"));
    const dbA = path.join(workspace, "data", "databases", "a", "data.db");
    const dbB = path.join(workspace, "data", "databases", "b", "data.db");
    fs.mkdirSync(path.dirname(dbA), { recursive: true });
    fs.mkdirSync(path.dirname(dbB), { recursive: true });
    fs.writeFileSync(dbA, "sqlite");
    fs.writeFileSync(dbB, "sqlite");

    markDbDirty("db-a", dbA, workspace);
    markDbDirty("db-b", dbB, workspace);

    const linked = new Set(["db-a"]);
    expect(listDbDirtySyncKeysForApp(linked, workspace)).toEqual(["db-a"]);

    fs.rmSync(workspace, { recursive: true, force: true });
  });
});
