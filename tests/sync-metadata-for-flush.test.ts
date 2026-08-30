import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockUploadAppDbConfig = vi.fn();
const mockUploadDatabasesRegistry = vi.fn();
const mockFlushMetadataOutbox = vi.fn();

vi.mock("../src/gateway/services/syncV3/appDbConfigUpload.js", () => ({
  uploadAppDbConfigToCloud: (...args: unknown[]) => mockUploadAppDbConfig(...args),
}));

vi.mock("../src/gateway/services/syncV3/MetadataRegistryClient.js", () => ({
  uploadDatabasesRegistryToCloud: (...args: unknown[]) =>
    mockUploadDatabasesRegistry(...args),
}));

vi.mock("../src/gateway/services/syncV3/metadataOutbox.js", () => ({
  flushMetadataOutbox: () => mockFlushMetadataOutbox(),
}));

vi.mock("../src/gateway/services/cloudSync/yieldEventLoop.js", () => ({
  yieldEventLoop: async () => undefined,
}));

import { syncMetadataToCloudForFlush } from "../src/gateway/services/syncV3/syncMetadataForFlush.js";

describe("syncMetadataToCloudForFlush", () => {
  let paprDir: string;
  const appId = "65b7eb05-5ec0-47da-918a-c63e64916f1e";

  beforeEach(() => {
    paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-metadata-flush-"));
    const appDir = path.join(paprDir, "apps", appId);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "data-sources.json"),
      JSON.stringify({ databases: {} }, null, 2),
    );
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(paprDir, "data", "databases.json"),
      JSON.stringify({ databases: {} }, null, 2),
    );

    mockUploadAppDbConfig.mockResolvedValue(true);
    mockUploadDatabasesRegistry.mockResolvedValue(true);
    mockFlushMetadataOutbox.mockResolvedValue({ flushed: 0, failed: 0 });
  });

  afterEach(() => {
    fs.rmSync(paprDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("succeeds when initial uploads succeed", async () => {
    await expect(
      syncMetadataToCloudForFlush(paprDir, appId, "sha-1"),
    ).resolves.toBeUndefined();
    expect(mockUploadAppDbConfig).toHaveBeenCalledTimes(1);
    expect(mockFlushMetadataOutbox).not.toHaveBeenCalled();
  });

  it("succeeds via outbox when direct upload fails then outbox flushes", async () => {
    mockUploadAppDbConfig.mockResolvedValueOnce(false);
    mockFlushMetadataOutbox.mockResolvedValueOnce({ flushed: 1, failed: 0 });

    await expect(
      syncMetadataToCloudForFlush(paprDir, appId, "sha-1"),
    ).resolves.toBeUndefined();

    expect(mockUploadAppDbConfig).toHaveBeenCalledTimes(1);
    expect(mockFlushMetadataOutbox).toHaveBeenCalledTimes(1);
  });

  it("throws when direct upload and outbox recovery both fail", async () => {
    mockUploadAppDbConfig.mockResolvedValue(false);
    mockUploadDatabasesRegistry.mockResolvedValue(false);
    mockFlushMetadataOutbox.mockResolvedValue({ flushed: 0, failed: 1 });

    await expect(
      syncMetadataToCloudForFlush(paprDir, appId, "sha-1"),
    ).rejects.toThrow(/Metadata sync to cloud failed/);

    expect(mockUploadAppDbConfig).toHaveBeenCalledTimes(2);
    expect(mockFlushMetadataOutbox).toHaveBeenCalledTimes(3);
  });
});
