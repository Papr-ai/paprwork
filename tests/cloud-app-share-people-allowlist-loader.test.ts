import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppRuntimeRouteAuth } from "../src/gateway/services/appRuntime/types.js";

const loadCloudPublishPrefs = vi.fn();
const fetchCachedRuntimeRepoFile = vi.fn();
const getSharePeopleAllowlistPush = vi.fn();

vi.mock("../src/gateway/services/cloudPublishPrefs.js", () => ({
  loadCloudPublishPrefs: (...args: unknown[]) => loadCloudPublishPrefs(...args),
}));

vi.mock("../src/gateway/services/appRuntime/cloudAppHostCache.js", () => ({
  fetchCachedRuntimeRepoFile: (...args: unknown[]) =>
    fetchCachedRuntimeRepoFile(...args),
}));

const runtimeFetch = vi.fn();
vi.mock("../src/gateway/services/appRuntime/memoryRuntimeClient.js", () => ({
  runtimeFetch: (...args: unknown[]) => runtimeFetch(...args),
  getCloudAppHostKey: () => "test-host-key",
}));

vi.mock("../src/gateway/utils/cloudApiClient.js", () => ({
  getMemoryServerBaseUrl: () => "https://memory.test",
}));

vi.mock("../src/gateway/services/appRuntime/cloudAppHostShareAllowlistPushStore.js", () => ({
  getSharePeopleAllowlistPush: (...args: unknown[]) =>
    getSharePeopleAllowlistPush(...args),
}));

import {
  parseSharePeopleAllowlistFromPrefsFile,
  loadSharePeopleAllowlistForCloudHost,
  fetchShareAllowlistFromMemoryPublish,
  invalidateMemoryShareAllowlistCache,
  CLOUD_PUBLISH_PREFS_REPO_PATH,
} from "../src/gateway/services/appRuntime/cloudAppSharePeopleAllowlistLoader.js";

const auth = {
  namespaceId: "ns-1",
  slug: "my-app",
} as AppRuntimeRouteAuth;

describe("parseSharePeopleAllowlistFromPrefsFile", () => {
  it("returns allowlist for matching app id", () => {
    const raw = JSON.stringify({
      apps: {
        "app-1": { allowedEmails: ["a@b.com"], allowedUserIds: ["u1"] },
      },
    });
    expect(parseSharePeopleAllowlistFromPrefsFile(raw, "app-1")).toEqual({
      allowedEmails: ["a@b.com"],
      allowedUserIds: ["u1"],
    });
  });

  it("returns undefined when no restriction fields are set", () => {
    const raw = JSON.stringify({ apps: { "app-1": { accessMode: "team" } } });
    expect(parseSharePeopleAllowlistFromPrefsFile(raw, "app-1")).toBeUndefined();
  });
});

describe("loadSharePeopleAllowlistForCloudHost", () => {
  beforeEach(() => {
    loadCloudPublishPrefs.mockReset();
    fetchCachedRuntimeRepoFile.mockReset();
    getSharePeopleAllowlistPush.mockReset();
    getSharePeopleAllowlistPush.mockReturnValue(undefined);
    runtimeFetch.mockReset();
    invalidateMemoryShareAllowlistCache();
  });

  it("uses local prefs when allowlist is present", async () => {
    loadCloudPublishPrefs.mockReturnValue({
      apps: { "app-1": { allowedEmails: ["local@x.com"] } },
    });
    const result = await loadSharePeopleAllowlistForCloudHost(auth, "app-1");
    expect(result).toEqual({ allowedEmails: ["local@x.com"] });
    expect(fetchCachedRuntimeRepoFile).not.toHaveBeenCalled();
  });

  it("uses host push store before repo file", async () => {
    loadCloudPublishPrefs.mockReturnValue({ apps: {} });
    getSharePeopleAllowlistPush.mockReturnValue({
      allowedEmails: ["pushed@x.com"],
    });
    const result = await loadSharePeopleAllowlistForCloudHost(auth, "app-1");
    expect(result).toEqual({ allowedEmails: ["pushed@x.com"] });
    expect(fetchCachedRuntimeRepoFile).not.toHaveBeenCalled();
  });

  it("falls back to synced repo file on cloud host", async () => {
    loadCloudPublishPrefs.mockReturnValue({ apps: {} });
    fetchCachedRuntimeRepoFile.mockResolvedValue({
      content: JSON.stringify({
        apps: { "app-1": { allowedEmailDomains: ["acme.com"] } },
      }),
      contentType: "application/json",
    });
    const result = await loadSharePeopleAllowlistForCloudHost(auth, "app-1");
    expect(result).toEqual({ allowedEmailDomains: ["acme.com"] });
    expect(fetchCachedRuntimeRepoFile).toHaveBeenCalledWith(
      auth,
      CLOUD_PUBLISH_PREFS_REPO_PATH,
    );
  });

  it("falls back to memory publish when local and repo have no allowlist", async () => {
    loadCloudPublishPrefs.mockReturnValue({ apps: {} });
    fetchCachedRuntimeRepoFile.mockResolvedValue(null);
    runtimeFetch
      .mockResolvedValueOnce({ status: 404, ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          allowedUserIds: ["user-from-memory"],
        }),
      });
    const result = await loadSharePeopleAllowlistForCloudHost(auth, "app-1");
    expect(result).toEqual({ allowedUserIds: ["user-from-memory"] });
    expect(runtimeFetch).toHaveBeenNthCalledWith(
      1,
      "https://memory.test/v1/cloud/apps/runtime/share-people-allowlist",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Cloud-App-Host-Key": "test-host-key",
        }),
      }),
      15_000,
    );
    expect(runtimeFetch).toHaveBeenNthCalledWith(
      2,
      "https://memory.test/v1/cloud/apps/publish/app-1",
      expect.objectContaining({
        method: "GET",
        headers: { "X-Cloud-App-Host-Key": "test-host-key" },
      }),
      15_000,
    );
  });

  it("reads nested shareAllowlist from memory publish", async () => {
    runtimeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        shareAllowlist: { allowedEmails: ["guest@client.com"] },
      }),
    });
    const result = await fetchShareAllowlistFromMemoryPublish("app-2");
    expect(result).toEqual({ allowedEmails: ["guest@client.com"] });
  });
});
