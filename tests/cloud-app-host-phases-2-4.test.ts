import { describe, expect, it } from "vitest";
import { dbTokenCacheExpiresAt } from "../src/gateway/services/appRuntime/dbTokenRuntimeCache.js";
import { deploySnapshotObjectPrefix } from "../src/gateway/services/appRuntime/gcsDeploySnapshot.js";

describe("dbTokenCacheExpiresAt", () => {
  it("honors memory expiresAt with safety margin", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const expiresAt = "2026-01-15T00:00:00.000Z";
    const cachedUntil = dbTokenCacheExpiresAt(expiresAt, now);
    expect(cachedUntil).toBe(Date.parse("2026-01-15T00:00:00.000Z") - 60_000);
  });

  it("falls back when expiresAt is missing", () => {
    const now = 1_000_000;
    expect(dbTokenCacheExpiresAt(undefined, now)).toBe(now + 50 * 60 * 1000);
  });
});

describe("deploy snapshot object prefix", () => {
  it("scopes objects under namespace/slug/revision", () => {
    expect(deploySnapshotObjectPrefix("ns-1", "leadership-sync", "abc123")).toBe(
      "deploys/ns-1/leadership-sync/abc123/",
    );
  });
});
