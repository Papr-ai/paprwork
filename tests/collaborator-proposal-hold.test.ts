/**
 * Teammate on the team's shared data: schema changes apply on their desktop
 * only (proposal hold), are never published by them, ride in the proposal from
 * the hold, and settle when the publisher approves or rejects.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addMigrationToHold,
  appendHoldJournal,
  getReplicaPublishHold,
  isReplicaHeld,
  listPublishableHolds,
  resetReplicaPublishHoldsForTests,
  shouldSkipSyncForHold,
} from "../src/gateway/services/tursoReplica/replicaPublishHold.js";
import { publishHeldDatabase, type HeldPublishDeps } from "../src/gateway/services/tursoReplica/publishHeldDatabases.js";
import { settleProposalHold, type SettleDeps } from "../src/gateway/services/tursoReplica/settleProposalHolds.js";
import { buildProposalChangeSet } from "../src/gateway/services/cloudSync/contributeChangeSet.js";
import { assertProposalMigrationsApplied } from "../src/gateway/services/CloudAppContributeService.js";

let root: string;
const db = () => path.join(root, "data.db");

function proposalHold(ids = ["0009_trigger"]) {
  for (const id of ids) {
    addMigrationToHold({
      localPath: db(),
      dbId: "db-f3115d59",
      purpose: "proposal",
      migration: { migrationId: id, sql: "CREATE TABLE x (id INTEGER PRIMARY KEY)", breaking: false, migrationRoot: root },
    });
  }
  return getReplicaPublishHold(db())!;
}

function settleDeps(over: Partial<SettleDeps> = {}): SettleDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    cloudAppliedIds: vi.fn(async () => new Set<string>()),
    latestProposalStatus: vi.fn(async () => "pending"),
    rebuildLocalFromCloud: vi.fn(async () => void calls.push("rebuild")),
    replayOne: vi.fn(async (_s, st) => void calls.push(`replay:${st.sql}`)),
    push: vi.fn(async () => (calls.push("push"), { ok: true })),
    quarantineMigrations: vi.fn(async () => void calls.push("quarantine")),
    ...over,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "prop-"));
  process.env.PAPR_HOME = root;
  resetReplicaPublishHoldsForTests();
});
afterEach(() => {
  delete process.env.PAPR_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("proposal hold", () => {
  it("holds sync like a publish hold but is never publishable", () => {
    proposalHold();
    expect(isReplicaHeld(db())).toBe(true);
    expect(shouldSkipSyncForHold(db())).toBe(true);
    expect(listPublishableHolds()).toEqual([]);
  });

  it("publish refuses a proposal hold even if called directly", async () => {
    const hold = proposalHold();
    const migrateCloud = vi.fn();
    await expect(publishHeldDatabase(hold, "d-f3115d59", { migrateCloud } as unknown as HeldPublishDeps)).rejects.toThrow(
      /proposed schema change/,
    );
    expect(migrateCloud).not.toHaveBeenCalled();
  });

  it("a proposal change can't be added to a publish hold (or the reverse)", () => {
    proposalHold();
    expect(() =>
      addMigrationToHold({
        localPath: db(),
        purpose: "publish",
        migration: { migrationId: "0010_x", sql: "", breaking: true },
      }),
    ).toThrow(/already holds a proposal change/);
  });

  it("holds written before proposals existed stay publish holds", () => {
    addMigrationToHold({ localPath: db(), migration: { migrationId: "0002_rename", sql: "", breaking: true } });
    expect(listPublishableHolds()).toHaveLength(1);
  });
});

describe("settleProposalHold", () => {
  it("waits while the proposal is pending: nothing local changes", async () => {
    const d = settleDeps();
    const r = await settleProposalHold(proposalHold(), d);
    expect(r?.outcome).toBe("pending");
    expect(d.calls).toEqual([]);
    expect(isReplicaHeld(db())).toBe(true);
  });

  it("approved (cloud ledger has every held migration): rebuild, replay, upload, release", async () => {
    proposalHold(["0009_trigger", "0010_more"]);
    appendHoldJournal(db(), [{ sql: "INSERT INTO x VALUES (1)" }]);
    const d = settleDeps({ cloudAppliedIds: async () => new Set(["0008", "0009_trigger", "0010_more"]) });
    const r = await settleProposalHold(getReplicaPublishHold(db())!, d);
    expect(r).toMatchObject({ outcome: "approved", replayed: 1, dropped: [] });
    expect(d.calls).toEqual(["rebuild", "replay:INSERT INTO x VALUES (1)", "push"]);
    expect(isReplicaHeld(db())).toBe(false);
  });

  it("partly on the cloud is not approved", async () => {
    proposalHold(["0009_trigger", "0010_more"]);
    const d = settleDeps({ cloudAppliedIds: async () => new Set(["0009_trigger"]) });
    expect((await settleProposalHold(getReplicaPublishHold(db())!, d))?.outcome).toBe("pending");
  });

  it("rejected: back to the cloud schema, writes that fit are kept, the rest reported, files quarantined", async () => {
    proposalHold();
    appendHoldJournal(db(), [{ sql: "INSERT INTO contacts VALUES (1)" }, { sql: "INSERT INTO x VALUES (1)" }]);
    const d = settleDeps({
      latestProposalStatus: async () => "rejected",
      replayOne: vi.fn(async (_s, st) => {
        if (st.sql.includes(" x ")) throw new Error("no such table: x");
      }),
    });
    const r = await settleProposalHold(getReplicaPublishHold(db())!, d);
    expect(r?.outcome).toBe("rejected");
    expect(r?.replayed).toBe(1);
    expect(r?.dropped).toEqual([{ sql: "INSERT INTO x VALUES (1)", error: "no such table: x" }]);
    expect(d.calls).toEqual(["rebuild", "push", "quarantine"]);
    expect(isReplicaHeld(db())).toBe(false);
  });

  it("approved but a replay fails: hold and journal kept for a retry", async () => {
    proposalHold();
    appendHoldJournal(db(), [{ sql: "INSERT INTO x VALUES (1)" }]);
    const d = settleDeps({
      cloudAppliedIds: async () => new Set(["0009_trigger"]),
      replayOne: async () => {
        throw new Error("busy");
      },
    });
    await expect(settleProposalHold(getReplicaPublishHold(db())!, d)).rejects.toThrow("busy");
    expect(isReplicaHeld(db())).toBe(true);
  });
});

describe("proposal migrations must have run", () => {
  const tree = (appliedIds: Set<string> | null | undefined) => ({
    repoDir: "databases/contacts/migrations",
    local: new Map([
      ["0008_tables.sql", "a"],
      ["0009_trigger.sql", "b"],
    ]),
    base: new Map([["0008_tables.sql", "a"]]),
    kind: "migrations" as const,
    ...(appliedIds !== undefined ? { appliedIds } : {}),
  });

  it("a held (applied) migration is proposed", () => {
    const c = buildProposalChangeSet([tree(new Set(["0008_tables", "0009_trigger"]))]);
    expect([...c.writes.keys()]).toEqual(["databases/contacts/migrations/0009_trigger.sql"]);
    expect(() => assertProposalMigrationsApplied(c)).not.toThrow();
  });

  it("a migration file that never ran blocks the proposal by name — never silently dropped", () => {
    const c = buildProposalChangeSet([tree(new Set(["0008_tables"]))]);
    expect(c.unapplied).toEqual(["databases/contacts/migrations/0009_trigger.sql"]);
    expect(() => assertProposalMigrationsApplied(c)).toThrow(/never ran.*0009_trigger\.sql/);
  });

  it("an unreadable ledger blocks too (unknown is not 'applied')", () => {
    const c = buildProposalChangeSet([tree(null)]);
    expect(() => assertProposalMigrationsApplied(c)).toThrow(/Couldn't read/);
  });

  it("job migration trees without a ledger check are unaffected", () => {
    const c = buildProposalChangeSet([tree(undefined)]);
    expect(c.unapplied).toEqual([]);
    expect(c.unverified).toEqual([]);
  });
});

describe("migration numbering on a teammate's copy", () => {
  it("numbers after the ledger, not just the files on disk", async () => {
    const { createMigrationFile } = await import("../src/gateway/services/jobs/migrationFileNaming.js");
    const r = await createMigrationFile({
      migrationRoot: root,
      name: "add col",
      sql: "SELECT 1",
      appliedIds: ["0001_baseline", "0002_20261001083352_create_notes"],
    });
    expect(r.fileName.startsWith("0003_")).toBe(true);
  });
});

