import { describe, expect, it, vi, afterEach } from "vitest";
import { pushJobsIndexToCloudAfterLocalWrite } from "../src/gateway/services/jobs/jobDeletionCatalogSync.js";

vi.mock("../src/gateway/services/syncV3/MetadataRegistryClient.js", () => ({
  uploadJobsIndexToCloud: vi.fn(async () => undefined),
  retryPendingMetadataUploads: vi.fn(async () => undefined),
}));

import {
  uploadJobsIndexToCloud,
  retryPendingMetadataUploads,
} from "../src/gateway/services/syncV3/MetadataRegistryClient.js";

describe("pushJobsIndexToCloudAfterLocalWrite", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips cloud upload when skipCloudUpload is true", async () => {
    await pushJobsIndexToCloudAfterLocalWrite([], "2026-01-01T00:00:00.000Z", {
      skipCloudUpload: true,
      awaitCloudMetadata: true,
    });
    expect(uploadJobsIndexToCloud).not.toHaveBeenCalled();
    expect(retryPendingMetadataUploads).not.toHaveBeenCalled();
  });
});
