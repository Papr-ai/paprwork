/**
 * Proposing with a new migration that never ran on this copy used to fail
 * ("These migration files never ran…") and abandon the proposal; teammates on
 * shared data couldn't even run it. Propose now runs it first.
 */
import { describe, expect, it, vi } from "vitest";

import {
  autoApplyProposalMigrations,
  unappliedIdsByTree,
  type AutoApplyTree,
} from "../../../src/gateway/services/cloudSync/proposalAutoApplyMigrations.js";
import { buildProposalChangeSet } from "../../../src/gateway/services/cloudSync/contributeChangeSet.js";
import { assertProposalMigrationsApplied } from "../../../src/gateway/services/CloudAppContributeService.js";

const DIR = "databases/fde-applications/migrations";
const M26 = "0026_20261103191012_lead_messages";
const M27 = "0027_20261108113213_lead_inmail";

const trees = (): AutoApplyTree[] => [
  { repoRelativeDir: "apps/a", kind: "app" },
  { repoRelativeDir: DIR, kind: "migrations", dbId: "db-1", appliedIds: new Set(["0025_x"]) },
];
const unapplied = [`${DIR}/${M27}.sql`, `${DIR}/${M26}.sql`];

describe("propose runs new migrations before refusing", () => {
  it("maps unapplied paths to their database, in filename order", () => {
    expect([...unappliedIdsByTree(trees(), unapplied)]).toEqual([[1, [M26, M27]]]);
  });

  it("applies each, records it, and the rebuilt change set passes", async () => {
    const t = trees();
    const apply = vi.fn(async () => ({ applied: true }));
    const out = await autoApplyProposalMigrations(t, unapplied, apply);
    expect(apply.mock.calls.map((c) => c[0])).toEqual([
      { dbId: "db-1", migrationId: M26 },
      { dbId: "db-1", migrationId: M27 },
    ]);
    expect(out).toEqual({ applied: [M26, M27], failed: [] });

    const changes = buildProposalChangeSet([
      {
        repoDir: DIR,
        kind: "migrations",
        base: new Map([["0025_x.sql", "x"]]),
        local: new Map([["0025_x.sql", "x"], [`${M26}.sql`, "a"], [`${M27}.sql`, "b"]]),
        appliedIds: t[1]!.appliedIds,
      },
    ]);
    expect(changes.unapplied).toEqual([]);
    expect(() => assertProposalMigrationsApplied(changes)).not.toThrow();
  });

  it("stops at the first failure and reports it and what it skipped", async () => {
    const t = trees();
    const apply = vi.fn(async () => {
      throw new Error("no such table: leads");
    });
    const out = await autoApplyProposalMigrations(t, unapplied, apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(out.applied).toEqual([]);
    expect(out.failed).toEqual([
      { path: `${DIR}/${M26}.sql`, error: "no such table: leads" },
      { path: `${DIR}/${M27}.sql`, error: "skipped after an earlier failure" },
    ]);
    expect(t[1]!.appliedIds).toEqual(new Set(["0025_x"]));
  });

  it("ignores job migration trees and paths outside the folder", async () => {
    const apply = vi.fn(async () => ({ applied: true }));
    const out = await autoApplyProposalMigrations(
      [{ repoRelativeDir: "Jobs/j/migrations", kind: "job" }, ...trees()],
      ["Jobs/j/migrations/0001_a.sql", `${DIR}/sub/0030_b.sql`],
      apply,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(out).toEqual({ applied: [], failed: [] });
  });
  it("team copy: an app-folder migration mirrored to the registry tree is caught as unapplied", () => {
    // Per-app repo: the app tree sits at "." and also carries databases/{slug}/migrations.
    const changes = buildProposalChangeSet([
      { repoDir: ".", kind: "app", base: new Map(), local: new Map([[`${DIR}/${M27}.sql`, "b"]]) },
      { repoDir: DIR, kind: "migrations", base: new Map(), local: new Map([[`${M27}.sql`, "b"]]), appliedIds: new Set(["0025_x"]) },
    ]);
    expect(changes.unapplied).toEqual([`${DIR}/${M27}.sql`]);
    expect([...unappliedIdsByTree(trees(), changes.unapplied)]).toEqual([[1, [M27]]]);
  });
});
