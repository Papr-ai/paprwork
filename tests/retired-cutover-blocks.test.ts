import { describe, expect, it } from "vitest";

import { isRetiredCutoverBlockReason } from "../src/gateway/services/tursoReplica/cutover/retiredCutoverBlocks.js";

describe("isRetiredCutoverBlockReason", () => {
  it("retires a block citing a synthetic drift-heal id", () => {
    // The exact string found in a real registry, where it had pinned the
    // database to the legacy sync path since Sep 3.
    expect(
      isRetiredCutoverBlockReason(
        "Migration SQL missing for __schema_drift_heal___1788489428341",
      ),
    ).toBe(true);
  });

  it("keeps a genuine missing migration blocked", () => {
    // Here the SQL really is needed and really is gone, so the block is a live
    // verdict, not a fossil. Retiring it would let cutover proceed against a
    // remote that never received the migration.
    expect(
      isRetiredCutoverBlockReason("Migration SQL missing for 0002_feed_schema"),
    ).toBe(false);
  });

  it("does not retire unrelated block reasons", () => {
    for (const reason of [
      "Database quarantined — repair required",
      "Migration ledger conflict — repair required",
      "Schema drift — Turso primary is ahead of local migration ledger",
      "Could not verify Turso remote state while local data exists",
      "database is locked",
    ]) {
      expect(isRetiredCutoverBlockReason(reason)).toBe(false);
    }
  });

  it("treats an absent or empty reason as not retired", () => {
    // A block with no recorded reason gives no evidence its cause is gone, so
    // the conservative answer is to leave it blocked.
    expect(isRetiredCutoverBlockReason(undefined)).toBe(false);
    expect(isRetiredCutoverBlockReason("")).toBe(false);
  });

  it("requires the drift-heal prefix on the id, not merely in the text", () => {
    // Guards against a substring match: the prefix has to start the migration
    // id, otherwise a real migration whose name mentions the heal would be
    // silently unblocked.
    expect(
      isRetiredCutoverBlockReason(
        "Migration SQL missing for 0003_after___schema_drift_heal__cleanup",
      ),
    ).toBe(false);
  });

  it("ignores a drift-heal id in a reason that is not a missing-SQL failure", () => {
    // Only the missing-SQL throw was made impossible. Any other failure
    // mentioning the same id is still a live block.
    expect(
      isRetiredCutoverBlockReason(
        "Remote rejected __schema_drift_heal___1788489428341",
      ),
    ).toBe(false);
  });
});
