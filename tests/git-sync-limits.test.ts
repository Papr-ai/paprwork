import { describe, expect, it } from "vitest";
import {
  formatGitSyncSizeLimitMb,
  isLocalOnlyCloudSyncArtifact,
  isTooLargeForGitSync,
  MAX_GIT_SYNC_FILE_BYTES,
} from "../src/gateway/services/cloudSync/gitSyncLimits.js";

describe("gitSyncLimits", () => {
  it("treats backup artifacts as local-only", () => {
    expect(isLocalOnlyCloudSyncArtifact("data.db.corrupt-1785826750.bak")).toBe(true);
    expect(isLocalOnlyCloudSyncArtifact("apps.json.corrupt-123")).toBe(true);
    expect(isLocalOnlyCloudSyncArtifact("data.db.corrupt-backup-2026")).toBe(true);
    expect(isLocalOnlyCloudSyncArtifact("icon.svg")).toBe(false);
    expect(isLocalOnlyCloudSyncArtifact("guide.pdf")).toBe(false);
  });

  it("allows small PDFs and blocks large files at 10MB", () => {
    expect(formatGitSyncSizeLimitMb()).toBe("10MB");
    expect(isTooLargeForGitSync(1024 * 1024)).toBe(false);
    expect(isTooLargeForGitSync(MAX_GIT_SYNC_FILE_BYTES)).toBe(false);
    expect(isTooLargeForGitSync(MAX_GIT_SYNC_FILE_BYTES + 1)).toBe(true);
    expect(isTooLargeForGitSync(25 * 1024 * 1024)).toBe(true);
  });
});
