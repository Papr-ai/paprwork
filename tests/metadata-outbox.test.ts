import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAppMetaFile } from "../src/gateway/services/cloudSync/cloudAppMeta.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const uploadAppRuntimeMetaToCloudDirect = vi.fn();

vi.mock("../src/gateway/services/syncV3/MetadataRegistryClient.js", () => ({
  uploadJobsIndexToCloudDirect: vi.fn(),
  uploadDatabasesRegistryToCloudDirect: vi.fn(),
  uploadAppRuntimeMetaToCloudDirect,
}));

import {
  clearMetadataOutboxForTests,
  enqueueMetadataOutboxEntry,
  flushMetadataOutbox,
} from "../src/gateway/services/syncV3/metadataOutbox.js";

const sampleMeta: CloudAppMetaFile = {
  schemaVersion: "1.0.0",
  distRevision: "abc123",
  requiredSchemaVersion: "migration-1",
  updatedAt: "2026-08-19T00:00:00.000Z",
};

describe("metadataOutbox app-runtime-meta", () => {
  useIsolatedPaprWorkspace("metadata-outbox");

  afterEach(async () => {
    await clearMetadataOutboxForTests();
    uploadAppRuntimeMetaToCloudDirect.mockReset();
  });

  it("flushes queued app runtime meta uploads", async () => {
    uploadAppRuntimeMetaToCloudDirect.mockResolvedValue(true);

    await enqueueMetadataOutboxEntry({
      kind: "app-runtime-meta",
      updatedAt: sampleMeta.updatedAt,
      appId: "app-1",
      appRuntimeMeta: sampleMeta,
    });

    const result = await flushMetadataOutbox();
    expect(result.flushed).toBe(1);
    expect(uploadAppRuntimeMetaToCloudDirect).toHaveBeenCalledWith("app-1", sampleMeta);
  });
});
