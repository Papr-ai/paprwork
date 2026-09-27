import { afterEach, describe, expect, test, vi } from "vitest";

const { uploadJobsIndexToCloud, retryPendingMetadataUploads } = vi.hoisted(
  () => ({
    uploadJobsIndexToCloud: vi.fn().mockResolvedValue(true),
    retryPendingMetadataUploads: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock("../src/gateway/services/syncV3/MetadataRegistryClient.js", () => ({
  uploadJobsIndexToCloud,
  retryPendingMetadataUploads,
}));

import { pushJobsIndexToCloudAfterLocalWrite } from "../src/gateway/services/jobs/jobDeletionCatalogSync.js";

describe("pushJobsIndexToCloudAfterLocalWrite", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("fire-and-forget upload when not awaiting metadata", async () => {
    await pushJobsIndexToCloudAfterLocalWrite([], "2026-01-01T00:00:00.000Z");
    expect(uploadJobsIndexToCloud).toHaveBeenCalledTimes(1);
    expect(retryPendingMetadataUploads).not.toHaveBeenCalled();
  });

  test("awaits upload and drains outbox on delete paths", async () => {
    await pushJobsIndexToCloudAfterLocalWrite([], "2026-01-01T00:00:00.000Z", {
      awaitCloudMetadata: true,
    });
    expect(uploadJobsIndexToCloud).toHaveBeenCalledTimes(1);
    expect(retryPendingMetadataUploads).toHaveBeenCalledTimes(1);
  });
});
