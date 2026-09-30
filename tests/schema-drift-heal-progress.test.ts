/**
 * Issue 103 — the drift heal re-shipped identical work forever.
 *
 * These pin the two properties that make the loop terminate: identical work
 * parks after a bounded number of passes, and any change in the work resets
 * the count (because the heal caps rebuilds at one per pass, so a converging
 * database legitimately ships something different each time).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { JobMigrationSchemaOp } from "../src/core/types/jobMigrations.js";
import {
  beginDriftHealPass,
  clearDriftHealProgress,
  driftHealWorkSignature,
  MAX_UNCHANGED_HEAL_PASSES,
  PARKED_RECHECK_INTERVAL_MS,
  recordDriftHealWork,
  resetDriftHealProgressForTests,
} from "../src/gateway/services/syncV3/schemaDriftHealProgress.js";

const KEY = "db-7129d83e";

/** The work observed looping on `papr-books`: nine migrations, seven ops. */
const BOOKS_MIGRATIONS = [
  "0001_init",
  "0004_review",
  "0007_qbo_error_log",
  "0008_push_ledger",
  "0015_unique_keys_for_upserts",
  "0016_restore_upsert_unique_indexes",
  "0017_upsert_unique_indexes",
  "0019_rebuild_typed_tables",
  "0020_repair_sync_infra_types",
];

function sqlOps(count: number): JobMigrationSchemaOp[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "sql" as const,
    statement: `ALTER TABLE t${i} RENAME TO u${i}`,
  }));
}

const BOOKS_WORK = {
  unsatisfied: BOOKS_MIGRATIONS,
  healOps: sqlOps(7),
};

describe("driftHealWorkSignature", () => {
  it("is stable across passes for identical work", () => {
    expect(driftHealWorkSignature(BOOKS_WORK)).toBe(
      driftHealWorkSignature(BOOKS_WORK),
    );
  });

  it("ignores ledger read order — an ordering difference is not progress", () => {
    const reversed = {
      unsatisfied: [...BOOKS_MIGRATIONS].reverse(),
      healOps: BOOKS_WORK.healOps,
    };
    expect(driftHealWorkSignature(reversed)).toBe(
      driftHealWorkSignature(BOOKS_WORK),
    );
  });

  it("changes when a migration becomes satisfied", () => {
    const fewer = {
      unsatisfied: BOOKS_MIGRATIONS.slice(1),
      healOps: BOOKS_WORK.healOps,
    };
    expect(driftHealWorkSignature(fewer)).not.toBe(
      driftHealWorkSignature(BOOKS_WORK),
    );
  });

  it("changes when the heal ops change", () => {
    const other = { unsatisfied: BOOKS_MIGRATIONS, healOps: sqlOps(6) };
    expect(driftHealWorkSignature(other)).not.toBe(
      driftHealWorkSignature(BOOKS_WORK),
    );
  });

  it("distinguishes op kinds the signature was not written around", () => {
    // Serializing per-kind would collapse drop_column/rename_column to the
    // same string and report two different payloads as identical work.
    const drop = driftHealWorkSignature({
      unsatisfied: [],
      healOps: [{ kind: "drop_column", table: "t", column: "c" }],
    });
    const rename = driftHealWorkSignature({
      unsatisfied: [],
      healOps: [{ kind: "rename_column", table: "t", from: "c", to: "d" }],
    });
    const add = driftHealWorkSignature({
      unsatisfied: [],
      healOps: [
        { kind: "add_column", table: "t", column: "c", type: "TEXT" },
      ],
    });
    expect(new Set([drop, rename, add]).size).toBe(3);
  });
});

describe("recordDriftHealWork", () => {
  beforeEach(() => {
    resetDriftHealProgressForTests();
  });

  it("ships the first pass", () => {
    const decision = recordDriftHealWork(
      KEY,
      driftHealWorkSignature(BOOKS_WORK),
    );
    expect(decision.ship).toBe(true);
    expect(decision.unchangedPasses).toBe(1);
    expect(decision.justParked).toBe(false);
  });

  it("tolerates MAX_UNCHANGED_HEAL_PASSES identical passes before parking", () => {
    const signature = driftHealWorkSignature(BOOKS_WORK);
    for (let pass = 1; pass <= MAX_UNCHANGED_HEAL_PASSES; pass += 1) {
      const decision = recordDriftHealWork(KEY, signature);
      expect(decision.ship).toBe(true);
      expect(decision.justParked).toBe(false);
    }
    const parked = recordDriftHealWork(KEY, signature);
    expect(parked.ship).toBe(false);
    expect(parked.justParked).toBe(true);
  });

  it("parks once — the stuck set is not re-logged on every re-measure", () => {
    const signature = driftHealWorkSignature(BOOKS_WORK);
    const now = 1_000_000;
    for (let pass = 0; pass <= MAX_UNCHANGED_HEAL_PASSES; pass += 1) {
      recordDriftHealWork(KEY, signature, now);
    }
    const again = recordDriftHealWork(
      KEY,
      signature,
      now + PARKED_RECHECK_INTERVAL_MS,
    );
    expect(again.ship).toBe(false);
    expect(again.justParked).toBe(false);
  });

  it("resets the count when the work changes", () => {
    const signature = driftHealWorkSignature(BOOKS_WORK);
    recordDriftHealWork(KEY, signature);
    recordDriftHealWork(KEY, signature);

    const changed = recordDriftHealWork(
      KEY,
      driftHealWorkSignature({
        unsatisfied: BOOKS_MIGRATIONS.slice(1),
        healOps: BOOKS_WORK.healOps,
      }),
    );
    expect(changed.ship).toBe(true);
    expect(changed.unchangedPasses).toBe(1);
  });

  it("resumes a parked database when the work finally changes", () => {
    const signature = driftHealWorkSignature(BOOKS_WORK);
    for (let pass = 0; pass <= MAX_UNCHANGED_HEAL_PASSES; pass += 1) {
      recordDriftHealWork(KEY, signature);
    }
    const resumed = recordDriftHealWork(KEY, "a-different-signature");
    expect(resumed.ship).toBe(true);
    expect(resumed.resumed).toBe(true);
  });

  it("tracks databases independently", () => {
    const signature = driftHealWorkSignature(BOOKS_WORK);
    for (let pass = 0; pass <= MAX_UNCHANGED_HEAL_PASSES; pass += 1) {
      recordDriftHealWork(KEY, signature);
    }
    expect(recordDriftHealWork("db-other", signature).ship).toBe(true);
  });

  it("clearing on convergence restores the full tolerance", () => {
    const signature = driftHealWorkSignature(BOOKS_WORK);
    recordDriftHealWork(KEY, signature);
    recordDriftHealWork(KEY, signature);
    recordDriftHealWork(KEY, signature);

    clearDriftHealProgress(KEY);

    // Drift returns: the same work must get its full allowance again, not
    // inherit a count from before it converged.
    for (let pass = 1; pass <= MAX_UNCHANGED_HEAL_PASSES; pass += 1) {
      expect(recordDriftHealWork(KEY, signature).ship).toBe(true);
    }
  });
});

describe("beginDriftHealPass", () => {
  beforeEach(() => {
    resetDriftHealProgressForTests();
  });

  it("proceeds for an unseen database", () => {
    expect(beginDriftHealPass(KEY).proceed).toBe(true);
  });

  it("skips the expensive remote scan while parked", () => {
    const signature = driftHealWorkSignature(BOOKS_WORK);
    const now = 5_000_000;
    for (let pass = 0; pass <= MAX_UNCHANGED_HEAL_PASSES; pass += 1) {
      recordDriftHealWork(KEY, signature, now);
    }
    const gate = beginDriftHealPass(KEY, now + 20_000);
    expect(gate.proceed).toBe(false);
    expect(gate.reason).toContain("parked");
  });

  it("re-measures once the interval elapses, so a fixed remote is noticed", () => {
    const signature = driftHealWorkSignature(BOOKS_WORK);
    const now = 5_000_000;
    for (let pass = 0; pass <= MAX_UNCHANGED_HEAL_PASSES; pass += 1) {
      recordDriftHealWork(KEY, signature, now);
    }
    expect(
      beginDriftHealPass(KEY, now + PARKED_RECHECK_INTERVAL_MS).proceed,
    ).toBe(true);
  });

  it("never parks permanently — a park always has a re-measure due", () => {
    expect(PARKED_RECHECK_INTERVAL_MS).toBeGreaterThan(0);
    expect(Number.isFinite(PARKED_RECHECK_INTERVAL_MS)).toBe(true);
  });
});
