import { describe, expect, it } from "vitest";
import { isReplicaMissingTableError } from "../src/gateway/services/tursoReplica/tursoReplicaSchemaDriftHeal.js";

describe("tursoReplicaSchemaDriftHeal", () => {
  it("detects missing-table errors from replica prepare failures", () => {
    expect(
      isReplicaMissingTableError(
        "prepare failed: Parse error: no such table: brief_reviews",
      ),
    ).toBe(true);
    expect(isReplicaMissingTableError("no such table: goals")).toBe(true);
    expect(isReplicaMissingTableError("timed out after 2500ms")).toBe(false);
  });
});
