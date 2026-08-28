import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/gateway/utils/cloudApiClient.js", () => ({
  cloudApiFetch: vi.fn(),
}));

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getPaprApiKey: vi.fn(),
}));

vi.mock("../src/gateway/services/jobs/jobRuntimeCloudUpload.js", () => ({
  deleteJobRuntimePatch: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/gateway/services/jobs/jobCloudSummary.js", () => ({
  deleteCloudJobCatalogEntry: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/gateway/services/jobs/jobTombstones.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/gateway/services/jobs/jobTombstones.js")
  >();
  return {
    ...actual,
    addJobTombstones: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/core/utils/paprRoot.js", () => ({
  getPaprRoot: vi.fn().mockReturnValue("/tmp/papr-job-cloud-cleanup-test"),
}));

const getCloudSyncService = vi.fn();

vi.mock("../src/gateway/services/CloudSyncService.js", () => ({
  getCloudSyncService,
}));

import { deleteJobCloudArtifacts } from "../src/gateway/services/jobs/jobCloudCleanup.js";
import { deleteCloudJobCatalogEntry } from "../src/gateway/services/jobs/jobCloudSummary.js";
import { deleteJobRuntimePatch } from "../src/gateway/services/jobs/jobRuntimeCloudUpload.js";
import { addJobTombstones } from "../src/gateway/services/jobs/jobTombstones.js";

describe("deleteJobCloudArtifacts", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("tombstones, deletes runtime + catalog, and enqueues git sync paths", async () => {
    const enqueueRelativePath = vi.fn();
    getCloudSyncService.mockReturnValue({
      enqueueRelativePath,
      pushNow: vi.fn().mockResolvedValue(undefined),
    });

    const result = await deleteJobCloudArtifacts("job-to-delete");

    expect(deleteJobRuntimePatch).toHaveBeenCalledWith("job-to-delete");
    expect(deleteCloudJobCatalogEntry).toHaveBeenCalledWith("job-to-delete");
    expect(addJobTombstones).toHaveBeenCalled();
    expect(enqueueRelativePath).toHaveBeenCalledWith("data/jobs.json");
    expect(enqueueRelativePath).toHaveBeenCalledWith("Jobs/job-to-delete");
    expect(enqueueRelativePath).toHaveBeenCalledWith("data/.job-tombstones.json");
    expect(result.tombstoned).toBe(true);
    expect(result.catalogDeleted).toBe(true);
    expect(result.workspacePushAttempted).toBe(true);
  });

  test("skips workspace push when deferring startup cleanup", async () => {
    getCloudSyncService.mockReturnValue({
      enqueueRelativePath: vi.fn(),
      pushNow: vi.fn(),
    });

    const result = await deleteJobCloudArtifacts("job-id", {
      skipWorkspacePush: true,
    });

    expect(getCloudSyncService().pushNow).not.toHaveBeenCalled();
    expect(result.workspacePushAttempted).toBe(false);
  });
});
