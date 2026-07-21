import { describe, expect, it } from "vitest";
import { resolveGitHubItemSyncStatus } from "../src/gateway/services/cloudSync/syncItemStatus.js";

describe("resolveGitHubItemSyncStatus", () => {
  it("returns synced for queued paths that are unchanged on disk", () => {
    expect(
      resolveGitHubItemSyncStatus(
        "Jobs/job-a",
        {
          "Jobs/job-a": {
            lastSyncAt: "2026-01-01T00:00:00.000Z",
            contentHash: "abc",
          },
        },
        ["Jobs/job-a"],
        () => false,
      ),
    ).toBe("synced");
  });

  it("returns pending for queued paths that still need upload", () => {
    expect(
      resolveGitHubItemSyncStatus(
        "Jobs/job-b",
        {},
        ["Jobs/job-b"],
        () => true,
      ),
    ).toBe("pending");
  });
});
