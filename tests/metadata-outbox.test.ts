import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAppMetaFile } from "../src/gateway/services/cloudSync/cloudAppMeta.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const uploadAppRuntimeMetaToCloudDirect = vi.fn();
const uploadSubAgentsIndexToCloudDirect = vi.fn();

vi.mock("../src/gateway/services/syncV3/MetadataRegistryClient.js", () => ({
  uploadJobsIndexToCloudDirect: vi.fn(),
  uploadDatabasesRegistryToCloudDirect: vi.fn(),
  uploadAppRuntimeMetaToCloudDirect,
  uploadSubAgentsIndexToCloudDirect,
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
    uploadSubAgentsIndexToCloudDirect.mockReset();
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

  it("flushes queued subagents index uploads", async () => {
    uploadSubAgentsIndexToCloudDirect.mockResolvedValue(true);

    await enqueueMetadataOutboxEntry({
      kind: "subagents",
      updatedAt: "2026-08-19T00:00:00.000Z",
      subagents: [
        {
          id: "agent-1",
          name: "Helper",
          description: "Test",
          systemPrompt: "Help",
          createdAt: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T00:00:00.000Z",
        },
      ],
    });

    const result = await flushMetadataOutbox();
    expect(result.flushed).toBe(1);
    expect(uploadSubAgentsIndexToCloudDirect).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: "agent-1", name: "Helper" }),
      ],
      "2026-08-19T00:00:00.000Z",
    );
  });
});
