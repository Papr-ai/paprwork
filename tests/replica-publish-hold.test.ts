import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMigrationToHold,
  appendHoldJournal,
  isReplicaHeld,
  isSyncKeyHeld,
  readHoldJournal,
  releaseReplicaPublishHold,
  resetReplicaPublishHoldsForTests,
  shouldSkipSyncForHold,
  withHoldBypass,
} from "../src/gateway/services/tursoReplica/replicaPublishHold.js";

let root: string;
const db = () => path.join(root, "data/databases/app/data.db");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hold-"));
  process.env.PAPR_HOME = root;
  resetReplicaPublishHoldsForTests();
});
afterEach(() => {
  delete process.env.PAPR_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("replica publish hold", () => {
  it("holds sync for one database and survives a restart", () => {
    addMigrationToHold({
      localPath: db(),
      dbId: "db-1",
      migration: { migrationId: "0002_rename", sql: "ALTER TABLE t RENAME COLUMN a TO b", breaking: true },
    });
    expect(shouldSkipSyncForHold(db())).toBe(true);
    expect(isSyncKeyHeld("db-1")).toBe(true);
    expect(shouldSkipSyncForHold(path.join(root, "other.db"))).toBe(false);

    resetReplicaPublishHoldsForTests(); // simulate restart: reload from disk
    expect(isReplicaHeld(db())).toBe(true);
  });

  it("journals writes only while held, in order", () => {
    appendHoldJournal(db(), [{ sql: "INSERT INTO t VALUES (0)" }]); // not held: ignored
    addMigrationToHold({ localPath: db(), migration: { migrationId: "m", sql: "DROP TABLE x", breaking: true } });
    appendHoldJournal(db(), [{ sql: "INSERT INTO t VALUES (?)", params: [1] }]);
    appendHoldJournal(db(), [{ sql: "UPDATE t SET b = 2" }]);
    expect(readHoldJournal(db()).map((e) => e.sql)).toEqual(["INSERT INTO t VALUES (?)", "UPDATE t SET b = 2"]);
  });

  it("lets only the publish procedure sync through, and release clears everything", async () => {
    addMigrationToHold({ localPath: db(), migration: { migrationId: "m", sql: "DROP TABLE x", breaking: true } });
    appendHoldJournal(db(), [{ sql: "INSERT INTO t VALUES (1)" }]);
    await withHoldBypass(db(), async () => expect(shouldSkipSyncForHold(db())).toBe(false));
    expect(shouldSkipSyncForHold(db())).toBe(true);

    releaseReplicaPublishHold(db());
    expect(isReplicaHeld(db())).toBe(false);
    expect(readHoldJournal(db())).toEqual([]);
  });

  it("does not duplicate a migration added twice", () => {
    const m = { migrationId: "m", sql: "DROP TABLE x", breaking: true };
    addMigrationToHold({ localPath: db(), migration: m });
    const h = addMigrationToHold({ localPath: db(), migration: m });
    expect(h.migrations).toHaveLength(1);
  });
});
