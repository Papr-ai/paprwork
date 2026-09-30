import { describe, expect, it } from "vitest";
import { resolveGitHubItemSyncStatus } from "../src/gateway/services/cloudSync/syncItemStatus.js";

describe("resolveGitHubItemSyncStatus tracked-in-git", () => {
  const tracked = new Set(["apps/on-git", "Jobs/on-git"]);

  it("reports outdated (not pending) when git has files but sync state entry is missing", () => {
    const status = resolveGitHubItemSyncStatus(
      "apps/on-git",
      {},
      [],
      () => true,
      undefined,
      tracked,
    );
    expect(status).toBe("outdated");
  });

  it("reports pending when never uploaded and not tracked in git", () => {
    const status = resolveGitHubItemSyncStatus(
      "apps/brand-new",
      {},
      [],
      () => true,
      undefined,
      tracked,
    );
    expect(status).toBe("pending");
  });

  it("reports pending when tracked but actively queued", () => {
    const status = resolveGitHubItemSyncStatus(
      "apps/on-git",
      {},
      ["apps/on-git"],
      () => true,
      undefined,
      tracked,
    );
    expect(status).toBe("pending");
  });

  it("reports synced when state entry exists and hash unchanged", () => {
    const status = resolveGitHubItemSyncStatus(
      "apps/on-git",
      {
        "apps/on-git": {
          lastSyncAt: "2026-01-01T00:00:00.000Z",
          contentHash: "abc",
        },
      },
      [],
      () => false,
      undefined,
      tracked,
    );
    expect(status).toBe("synced");
  });
});
