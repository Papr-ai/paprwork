import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockUploadAppDbConfig = vi.fn();
const mockSyncDatabasesRegistry = vi.fn();
const mockFlushMetadataOutbox = vi.fn();

vi.mock("../src/gateway/services/syncV3/appDbConfigUpload.js", () => ({
  uploadAppDbConfigToCloud: (...args: unknown[]) => mockUploadAppDbConfig(...args),
}));

vi.mock("../src/gateway/services/syncV3/databasesRegistryCloudSync.js", () => ({
  syncDatabasesRegistryToCloudCoalesced: (...args: unknown[]) =>
    mockSyncDatabasesRegistry(...args),
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
    mockSyncDatabasesRegistry.mockResolvedValue({
      uploaded: true,
      skippedDuplicate: false,
      queuedForRetry: false,
    });
    mockFlushMetadataOutbox.mockResolvedValue({ flushed: 0, failed: 0 });
  });

  afterEach(() => {
    fs.rmSync(paprDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns success when initial uploads succeed", async () => {
    const result = await syncMetadataToCloudForFlush(paprDir, appId, "sha-1");
    expect(result.warnings).toEqual([]);
    expect(result.appDbConfigUploaded).toBe(true);
    expect(result.databasesRegistryUploaded).toBe(true);
    expect(mockUploadAppDbConfig).toHaveBeenCalledTimes(1);
    expect(mockFlushMetadataOutbox).not.toHaveBeenCalled();
  });

  it("does not throw when direct upload fails — returns warnings and retries outbox", async () => {
    mockUploadAppDbConfig.mockResolvedValueOnce(false);
    mockSyncDatabasesRegistry.mockResolvedValueOnce({
      uploaded: false,
      skippedDuplicate: false,
      queuedForRetry: true,
    });
    mockFlushMetadataOutbox.mockResolvedValueOnce({ flushed: 0, failed: 1 });

    const result = await syncMetadataToCloudForFlush(paprDir, appId, "sha-1");

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(mockFlushMetadataOutbox).toHaveBeenCalled();
  });

  it("clears warnings when outbox recovery succeeds", async () => {
    mockUploadAppDbConfig.mockResolvedValueOnce(false);
    mockSyncDatabasesRegistry.mockResolvedValueOnce({
      uploaded: false,
      skippedDuplicate: false,
      queuedForRetry: true,
    });
    mockFlushMetadataOutbox.mockResolvedValueOnce({ flushed: 2, failed: 0 });

    const result = await syncMetadataToCloudForFlush(paprDir, appId, "sha-1");

    expect(result.warnings).toEqual([]);
    expect(result.metadataOutboxRecovered).toBe(true);
  });
});
