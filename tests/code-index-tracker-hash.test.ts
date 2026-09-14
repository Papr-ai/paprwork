import { describe, expect, test } from "vitest";

/** Pure logic mirrored from CodeIndexTracker.needsIndexingWithHash (no SQLite). */
function needsIndexingWithHash(
  storedHash: string | undefined,
  contentHash: string,
): boolean {
  if (!storedHash) {
    return true;
  }
  return storedHash !== contentHash;
}

describe("needsIndexingWithHash logic", () => {
  test("detects new and changed files", () => {
    expect(needsIndexingWithHash(undefined, "abc")).toBe(true);
    expect(needsIndexingWithHash("abc", "abc")).toBe(false);
    expect(needsIndexingWithHash("abc", "def")).toBe(true);
  });
});
