import { describe, expect, it } from "vitest";
import { resolveGitHubItemSyncStatus } from "../src/gateway/services/cloudSync/syncItemStatus.js";

describe("resolveGitHubItemSyncStatus", () => {
  it("reports failed when item is in dead-letter", () => {
    const status = resolveGitHubItemSyncStatus(
      "apps/broken",
      { "apps/broken": { lastSyncAt: "2026-01-01T00:00:00.000Z", contentHash: "abc" } },
      [],
      () => false,
      {
        "apps/broken": {
          lastFailedAt: "2026-01-02T00:00:00.000Z",
          failures: 3,
          lastError: "push timeout",
        },
      },
    );
    expect(status).toBe("failed");
  });
});
