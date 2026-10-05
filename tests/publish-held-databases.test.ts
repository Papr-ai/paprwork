import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMigrationToHold,
  appendHoldJournal,
  getReplicaPublishHold,
  isReplicaHeld,
  readHoldJournal,
  resetReplicaPublishHoldsForTests,
  shouldSkipSyncForHold,
} from "../src/gateway/services/tursoReplica/replicaPublishHold.js";
import {
  HeldPublishVerifyError,
  publishHeldDatabase,
  type HeldPublishDeps,
} from "../src/gateway/services/tursoReplica/publishHeldDatabases.js";

let root: string;
const db = () => path.join(root, "data.db");

function hold() {
  addMigrationToHold({
    localPath: db(),
    dbId: "db-1",
    migration: { migrationId: "0002_rename", sql: "ALTER TABLE t RENAME COLUMN a TO b", breaking: true, migrationRoot: root },
  });
  appendHoldJournal(db(), [{ sql: "INSERT INTO t (b) VALUES (?)", params: [1] }]);
  return getReplicaPublishHold(db())!;
}

function deps(over: Partial<HeldPublishDeps> = {}): HeldPublishDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    migrateCloud: vi.fn(async () => (calls.push("migrate"), ["0002_rename"])),
    listCloudTables: vi.fn(async () => ["t"]),
    listLocalTables: vi.fn(async () => ["t"]),
    rebuildLocalFromCloud: vi.fn(async () => void calls.push("rebuild")),
    replay: vi.fn(async (_s, st) => {
      // replay must run with sync allowed and must not re-journal itself
      expect(shouldSkipSyncForHold(db())).toBe(false);
      appendHoldJournal(db(), st);
      calls.push(`replay:${st.length}`);
    }),
    push: vi.fn(async () => (calls.push("push"), { ok: true })),
    ...over,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pub-"));
  process.env.PAPR_HOME = root;
  resetReplicaPublishHoldsForTests();
});
afterEach(() => {
  delete process.env.PAPR_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("publishHeldDatabase", () => {
  it("migrates cloud, verifies, rebuilds, replays held writes, uploads, releases", async () => {
    const d = deps();
    const r = await publishHeldDatabase(hold(), "d-1", d);
    expect(d.calls).toEqual(["migrate", "rebuild", "replay:1", "push"]);
    expect(r).toMatchObject({ ok: true, migrated: ["0002_rename"], replayed: 1 });
    expect(isReplicaHeld(db())).toBe(false);
  });

  it("stops before touching local when the cloud schema doesn't match; hold and journal stay", async () => {
    const d = deps({ listCloudTables: vi.fn(async () => ["t", "t_new"]) });
    await expect(publishHeldDatabase(hold(), "d-1", d)).rejects.toBeInstanceOf(HeldPublishVerifyError);
    expect(d.calls).toEqual(["migrate"]);
    expect(isReplicaHeld(db())).toBe(true);
    expect(readHoldJournal(db())).toHaveLength(1);
    expect(shouldSkipSyncForHold(db())).toBe(true);
  });

  it("keeps the hold and journal when the upload after replay fails, so a retry is safe", async () => {
    const d = deps({ push: vi.fn(async () => ({ ok: false, error: "network" })) });
    await expect(publishHeldDatabase(hold(), "d-1", d)).rejects.toThrow(/network/);
    expect(isReplicaHeld(db())).toBe(true);
    expect(readHoldJournal(db())).toHaveLength(1);

    const retry = deps();
    await publishHeldDatabase(getReplicaPublishHold(db())!, "d-1", retry);
    expect(retry.calls).toEqual(["migrate", "rebuild", "replay:1", "push"]);
    expect(isReplicaHeld(db())).toBe(false);
  });
});

describe("publishHeldDatabase column-level verify", () => {
  it("stops when a column rename didn't land on the cloud", async () => {
    const d = deps({
      listCloudTables: vi.fn(async () => ["t(a,id)"]),
      listLocalTables: vi.fn(async () => ["t(b,id)"]),
    });
    await expect(publishHeldDatabase(hold(), "d-1", d)).rejects.toThrow(/cloud only: t\(a,id\).*local only: t\(b,id\)/);
    expect(isReplicaHeld(db())).toBe(true);
  });
});

describe("publishHeldDatabase crash resume (S6)", () => {
  it("does not replay again when a previous run uploaded the replay but crashed before release", async () => {
    let n = 0;
    const crashing = deps({
      push: vi.fn(async () => ({ ok: true })),
      rebuildLocalFromCloud: vi.fn(async () => {}),
    });
    // simulate: push ok → marker written → crash before release
    const realRelease = await import("../src/gateway/services/tursoReplica/replicaPublishHold.js");
    const spy = vi.spyOn(realRelease, "releaseReplicaPublishHold").mockImplementationOnce(() => {
      n += 1;
      throw new Error("CRASH before release");
    });
    await expect(publishHeldDatabase(hold(), "d-1", crashing)).rejects.toThrow(/CRASH/);
    spy.mockRestore();
    expect(n).toBe(1);
    expect(isReplicaHeld(db())).toBe(true);

    const retry = deps();
    const r = await publishHeldDatabase(getReplicaPublishHold(db())!, "d-1", retry);
    expect(r.replayed).toBe(0);
    expect(retry.calls).toEqual(["migrate"]);
    expect(isReplicaHeld(db())).toBe(false);
  });
});

describe("held publish schema signature", () => {
  it("ignores platform _papr_ columns that exist on only one side", async () => {
    const { signature } = await import("../src/gateway/services/tursoReplica/publishHeldDatabases.js");
    expect(signature("dc_r1", ["id", "name", "_papr_row_version", "_papr_created_at"])).toBe(signature("dc_r1", ["name", "id"]));
  });
});
