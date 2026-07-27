import { describe, expect, it } from "vitest";
import type { CustomKey } from "../src/core/storage/CustomKeysStorage.js";
import {
  dedupeCustomKeysByName,
  pickNewestCustomKeyByName,
  pickNewestCustomKeyEntryByName,
} from "../src/core/storage/customKeysDedupe.js";

function makeKey(
  id: string,
  name: string,
  updatedAt: string,
): CustomKey {
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

describe("customKeysDedupe", () => {
  it("pickNewestCustomKeyByName returns the newest duplicate", () => {
    const keys = [
      makeKey("a", "PAPR_API_KEY", "2026-01-01T00:00:00.000Z"),
      makeKey("b", "PAPR_API_KEY", "2026-07-27T00:00:00.000Z"),
      makeKey("c", "OPENAI_API_KEY", "2026-07-27T00:00:00.000Z"),
    ];

    expect(pickNewestCustomKeyByName(keys, "PAPR_API_KEY")?.id).toBe("b");
  });

  it("pickNewestCustomKeyEntryByName returns the newest duplicate entry", () => {
    const entries: Array<[string, CustomKey]> = [
      ["old", makeKey("old", "PAPR_API_KEY", "2026-01-01T00:00:00.000Z")],
      ["new", makeKey("new", "PAPR_API_KEY", "2026-07-27T00:00:00.000Z")],
    ];

    expect(pickNewestCustomKeyEntryByName(entries, "PAPR_API_KEY")?.id).toBe(
      "new",
    );
  });

  it("dedupeCustomKeysByName removes older duplicates", () => {
    const keys = new Map<string, CustomKey>([
      ["old", makeKey("old", "PAPR_API_KEY", "2026-01-01T00:00:00.000Z")],
      ["new", makeKey("new", "PAPR_API_KEY", "2026-07-27T00:00:00.000Z")],
      ["other", makeKey("other", "OPENAI_API_KEY", "2026-07-27T00:00:00.000Z")],
    ]);

    expect(dedupeCustomKeysByName(keys)).toBe(true);
    expect(keys.size).toBe(2);
    expect(keys.has("new")).toBe(true);
    expect(keys.has("old")).toBe(false);
  });
});
