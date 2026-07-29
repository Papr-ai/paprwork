import { describe, expect, it } from "vitest";
import type { CustomKey } from "../src/core/storage/CustomKeysStorage.js";
import {
  isVaultClonedFromLocal,
  stripClonedOrgVault,
} from "../src/core/storage/customKeysOrgVaultMigration.js";

function makeKey(id: string, name: string, updatedAt: string): CustomKey {
  return {
    id,
    name,
    permission: "always",
    clientAccess: "server",
    encryptedValue: "encrypted",
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("customKeysOrgVaultMigration", () => {
  it("detects exact _local clones by key id set", () => {
    const localIds = new Set(["a", "b", "c"]);
    const orgKeys = new Map([
      ["a", makeKey("a", "OPENAI_API_KEY", "2026-01-01T00:00:00.000Z")],
      ["b", makeKey("b", "NEON_API_KEY", "2026-01-01T00:00:00.000Z")],
      ["c", makeKey("c", "PAPR_API_KEY", "2026-01-01T00:00:00.000Z")],
    ]);

    expect(isVaultClonedFromLocal(localIds, orgKeys)).toBe(true);
  });

  it("rejects org vaults that differ from _local", () => {
    const localIds = new Set(["a", "b"]);
    const orgKeys = new Map([
      ["a", makeKey("a", "OPENAI_API_KEY", "2026-01-01T00:00:00.000Z")],
      ["x", makeKey("x", "PAPR_API_KEY", "2026-07-27T00:00:00.000Z")],
    ]);

    expect(isVaultClonedFromLocal(localIds, orgKeys)).toBe(false);
  });

  it("stripClonedOrgVault keeps only newest PAPR_API_KEY", () => {
    const orgKeys = new Map([
      ["old", makeKey("old", "PAPR_API_KEY", "2026-01-01T00:00:00.000Z")],
      ["new", makeKey("new", "PAPR_API_KEY", "2026-07-27T00:00:00.000Z")],
      ["openai", makeKey("openai", "OPENAI_API_KEY", "2026-07-27T00:00:00.000Z")],
    ]);

    const stripped = stripClonedOrgVault(orgKeys);
    expect(stripped.size).toBe(1);
    expect(stripped.has("new")).toBe(true);
  });
});
