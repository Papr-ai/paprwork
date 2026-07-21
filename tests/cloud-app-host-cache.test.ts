import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheControlForAppAsset,
  fetchCachedRuntimeRepoFile,
  resetCloudAppHostCachesForTests,
  validateCachedAccess,
} from "../src/gateway/services/appRuntime/cloudAppHostCache.js";
import type { AppPublishResolver, AppRuntimeRouteAuth } from "../src/gateway/services/appRuntime/types.js";

vi.mock("../src/gateway/services/appRuntime/memoryRuntimeClient.js", () => ({
  fetchRuntimeRepoFile: vi.fn(),
}));

import { fetchRuntimeRepoFile } from "../src/gateway/services/appRuntime/memoryRuntimeClient.js";

const auth: AppRuntimeRouteAuth = {
  namespaceId: "ns-1",
  slug: "my-app",
};

afterEach(() => {
  resetCloudAppHostCachesForTests();
  vi.clearAllMocks();
});

describe("cloudAppHostCache", () => {
  it("caches repo file fetches within TTL", async () => {
    vi.mocked(fetchRuntimeRepoFile).mockResolvedValue({
      content: "console.log('hi')",
      contentType: "text/javascript",
    });

    await fetchCachedRuntimeRepoFile(auth, "app.tsx");
    await fetchCachedRuntimeRepoFile(auth, "app.tsx");

    expect(fetchRuntimeRepoFile).toHaveBeenCalledTimes(1);
  });

  it("caches access validation within TTL", async () => {
    const publishResolver: AppPublishResolver = {
      validateAccess: vi.fn().mockResolvedValue({
        orgId: "org",
        namespaceId: "ns-1",
        userId: "user",
        appId: "app-1",
        mode: "owner",
        canRead: true,
        canWrite: true,
      }),
    };

    await validateCachedAccess(publishResolver, auth);
    await validateCachedAccess(publishResolver, auth);

    expect(publishResolver.validateAccess).toHaveBeenCalledTimes(1);
  });

  it("sets longer cache for dist assets", () => {
    expect(cacheControlForAppAsset("dist/app.js")).toContain("immutable");
    expect(cacheControlForAppAsset("index.html")).toContain("max-age=60");
    expect(cacheControlForAppAsset("styles.css")).toContain("max-age=600");
  });
});
