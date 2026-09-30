import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

import type { AppRepoHeadResponse } from "../src/core/types/appRepoWriterOps.js";
import { isAppCodeRecentlyVerified, isLocalAppCodeAtRemoteHead } from "../src/gateway/services/syncV3/appRepoHeadSyncCheck.js";

const { readAppRepoCommitCursors, readOidCache } = vi.hoisted(() => ({
  readAppRepoCommitCursors: vi.fn(),
  readOidCache: vi.fn(),
}));

vi.mock("../src/gateway/services/syncV3/appRepoCommittedFanout.js", () => ({
  readAppRepoCommitCursors,
}));

vi.mock("../src/gateway/services/syncV3/OidCache.js", () => ({
  readOidCache,
}));

const head: AppRepoHeadResponse = {
  commitSha: "abc123def456",
  files: [
    { path: "app.js", blobOid: "oid-app" },
    { path: "styles.css", blobOid: "oid-css" },
  ],
};

describe("isLocalAppCodeAtRemoteHead", () => {
  beforeEach(() => {
    readAppRepoCommitCursors.mockReset();
    readOidCache.mockReset();
  });

  test("returns true when commit cursor matches head", async () => {
    readAppRepoCommitCursors.mockResolvedValue({
      "app-1": { lastCommitSha: "abc123def456", updatedAt: "2026-01-01" },
    });
    readOidCache.mockResolvedValue({ version: 1, updatedAt: "", apps: {} });

    await expect(isLocalAppCodeAtRemoteHead("app-1", head)).resolves.toBe(true);
    expect(readOidCache).not.toHaveBeenCalled();
  });

  test("returns true when acked OIDs match head files", async () => {
    readAppRepoCommitCursors.mockResolvedValue({});
    readOidCache.mockResolvedValue({
      version: 1,
      updatedAt: "",
      apps: {
        "app-1": {
          "app.js": "oid-app",
          "styles.css": "oid-css",
        },
      },
    });

    await expect(isLocalAppCodeAtRemoteHead("app-1", head)).resolves.toBe(true);
  });

  test("returns false when OID differs", async () => {
    readAppRepoCommitCursors.mockResolvedValue({});
    readOidCache.mockResolvedValue({
      version: 1,
      updatedAt: "",
      apps: {
        "app-1": {
          "app.js": "oid-stale",
          "styles.css": "oid-css",
        },
      },
    });

    await expect(isLocalAppCodeAtRemoteHead("app-1", head)).resolves.toBe(false);
  });

  test("returns false when no cursor and no oid cache", async () => {
    readAppRepoCommitCursors.mockResolvedValue({});
    readOidCache.mockResolvedValue({ version: 1, updatedAt: "", apps: {} });

    await expect(isLocalAppCodeAtRemoteHead("app-1", head)).resolves.toBe(false);
  });
});

describe("isAppCodeRecentlyVerified", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns verified when cursor is within TTL", () => {
    const result = isAppCodeRecentlyVerified("app-1", {
      "app-1": {
        lastCommitSha: "abc123",
        updatedAt: "2026-09-06T11:59:30.000Z",
      },
    });
    expect(result).toEqual({ verified: true, commitSha: "abc123" });
  });

  test("returns false when cursor is older than TTL", () => {
    const result = isAppCodeRecentlyVerified("app-1", {
      "app-1": {
        lastCommitSha: "abc123",
        updatedAt: "2026-09-06T11:00:00.000Z",
      },
    });
    expect(result).toEqual({ verified: false });
  });
});
