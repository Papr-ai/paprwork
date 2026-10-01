import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUpload = vi.fn();

vi.mock("../src/gateway/services/syncV3/MetadataRegistryClient.js", () => ({
  uploadDatabasesRegistryToCloud: (...args: unknown[]) => mockUpload(...args),
}));

vi.mock("../src/gateway/services/databaseRegistryTombstonePolicy.js", () => ({
  sanitizeDatabasesRegistryForCloudExport: (registry: unknown) => ({
    registry,
    strippedDbIds: [],
  }),
}));

import {
  resetDatabasesRegistryCloudSyncStateForTests,
  syncDatabasesRegistryToCloudCoalesced,
} from "../src/gateway/services/syncV3/databasesRegistryCloudSync.js";

describe("syncDatabasesRegistryToCloudCoalesced", () => {
  const paprDir = "/tmp/papr-coalesce-test";
  const registry = { version: 1, databases: { "db-1": { status: "active" } } };

  beforeEach(() => {
    resetDatabasesRegistryCloudSyncStateForTests();
    mockUpload.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips duplicate PUT within coalesce window", async () => {
    const first = await syncDatabasesRegistryToCloudCoalesced(paprDir, registry);
    const second = await syncDatabasesRegistryToCloudCoalesced(paprDir, registry);

    expect(first.uploaded).toBe(true);
    expect(first.skippedDuplicate).toBe(false);
    expect(second.skippedDuplicate).toBe(true);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it("uploads again when force is set", async () => {
    await syncDatabasesRegistryToCloudCoalesced(paprDir, registry);
    await syncDatabasesRegistryToCloudCoalesced(paprDir, registry, {
      force: true,
    });

    expect(mockUpload).toHaveBeenCalledTimes(2);
  });
});
