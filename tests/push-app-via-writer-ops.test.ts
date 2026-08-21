import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSyncService } from "../src/gateway/services/CloudSyncService.js";

const mockEnsureAppRepoRecord = vi.fn();
const mockListPendingOutboxEntries = vi.fn();
const mockCollectAppOpFiles = vi.fn();
const mockPrepareAppForCloudGitSync = vi.fn();
const mockPostAppOps = vi.fn();
const mockAppendOutboxEntry = vi.fn();
const mockMarkOutboxInflight = vi.fn();
const mockMarkOutboxAcked = vi.fn();

vi.mock("../src/gateway/services/syncV3/AppRepoClient.js", () => ({
  ensureAppRepoRecord: (...args: unknown[]) => mockEnsureAppRepoRecord(...args),
  getAppRepoRecord: vi.fn(async () => null),
}));

vi.mock("../src/gateway/services/syncV3/SyncOutbox.js", () => ({
  listPendingOutboxEntries: (...args: unknown[]) =>
    mockListPendingOutboxEntries(...args),
  appendOutboxEntry: (...args: unknown[]) => mockAppendOutboxEntry(...args),
  markOutboxInflight: (...args: unknown[]) => mockMarkOutboxInflight(...args),
  markOutboxAcked: (...args: unknown[]) => mockMarkOutboxAcked(...args),
  markOutboxFailed: vi.fn(),
}));

vi.mock("../src/gateway/services/syncV3/collectAppOpFiles.js", () => ({
  collectAppOpFiles: (...args: unknown[]) => mockCollectAppOpFiles(...args),
  refreshOpParentHashes: vi.fn(async (_appId: string, files: unknown[]) => files),
  resolveWriterSyncedLocalPaths: vi.fn(async () => ["apps/app-1"]),
}));

vi.mock("../src/gateway/services/syncV3/AppOpsClient.js", () => ({
  postAppOps: (...args: unknown[]) => mockPostAppOps(...args),
}));

vi.mock("../src/gateway/services/cloudSync/prepareAppsForCloud.js", () => ({
  prepareAppForCloudGitSync: (...args: unknown[]) =>
    mockPrepareAppForCloudGitSync(...args),
}));

import { pushAppViaWriterOps } from "../src/gateway/services/syncV3/pushAppViaWriterOps.js";

describe("pushAppViaWriterOps lazy ensure", () => {
  const sync = {
    getPaprDir: () => "/tmp/papr",
    markRelativePathSynced: vi.fn(),
  } as unknown as CloudSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureAppRepoRecord.mockResolvedValue({
      appId: "app-1",
      githubOrg: "papr-shard-0001",
      repoName: "app-app-1",
    });
    mockListPendingOutboxEntries.mockResolvedValue([]);
    mockPrepareAppForCloudGitSync.mockResolvedValue(undefined);
    mockCollectAppOpFiles.mockResolvedValue({
      files: [{ path: "index.html", content: "<html></html>", parentHash: "abc" }],
      skippedUnchanged: 0,
    });
    mockAppendOutboxEntry.mockResolvedValue({
      id: "outbox-1",
      author: "paprwork-desktop",
      message: "app sync",
      idempotencyKey: "key-1",
    });
    mockMarkOutboxInflight.mockResolvedValue(undefined);
    mockMarkOutboxAcked.mockResolvedValue(undefined);
    mockPostAppOps.mockResolvedValue({ commitSha: "sha-1" });
  });

  it("calls ensureAppRepoRecord before posting writer ops", async () => {
    const callOrder: string[] = [];
    mockEnsureAppRepoRecord.mockImplementation(async () => {
      callOrder.push("ensure");
      return {
        appId: "app-1",
        githubOrg: "papr-shard-0001",
        repoName: "app-app-1",
      };
    });
    mockPostAppOps.mockImplementation(async () => {
      callOrder.push("post");
      return { commitSha: "sha-1" };
    });

    await pushAppViaWriterOps(sync, "app-1");

    expect(mockEnsureAppRepoRecord).toHaveBeenCalledWith("app-1");
    expect(mockPostAppOps).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["ensure", "post"]);
  });
});
