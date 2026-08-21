import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheControlForAppAsset,
  fetchCachedRuntimeRepoFile,
  invalidateRepoCacheForPublishedApp,
  resetCloudAppHostCachesForTests,
  validateCachedAccess,
} from "../src/gateway/services/appRuntime/cloudAppHostCache.js";
import type { AppPublishResolver, AppRuntimeRouteAuth } from "../src/gateway/services/appRuntime/types.js";
import { PAPR_APP_CLOUD_REVISION_PATH } from "../src/gateway/services/cloudSync/cloudAppRevisionMarker.js";

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
    vi.mocked(fetchRuntimeRepoFile).mockImplementation(async (_auth, path) => {
      if (typeof path === "string" && path.includes(PAPR_APP_CLOUD_REVISION_PATH)) {
        return { content: "rev-1\n", contentType: "text/plain" };
      }
      return {
        content: "console.log('hi')",
        contentType: "text/javascript",
      };
    });

    await fetchCachedRuntimeRepoFile(auth, "app.tsx");
    await fetchCachedRuntimeRepoFile(auth, "app.tsx");

    // First load: per-app revision marker + file; second load: fully cached.
    expect(fetchRuntimeRepoFile).toHaveBeenCalledTimes(2);
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

  it("does not cache access denials", async () => {
    const publishResolver: AppPublishResolver = {
      validateAccess: vi.fn().mockResolvedValue(null),
    };

    await validateCachedAccess(publishResolver, auth);
    await validateCachedAccess(publishResolver, auth);

    expect(publishResolver.validateAccess).toHaveBeenCalledTimes(2);
  });

  it("invalidates access cache when repo cache is busted for publish", async () => {
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
    invalidateRepoCacheForPublishedApp("ns-1", "my-app");
    await validateCachedAccess(publishResolver, auth);

    expect(publishResolver.validateAccess).toHaveBeenCalledTimes(2);
  });

  it("does not cache missing repo files (always retry origin)", async () => {
    vi.mocked(fetchRuntimeRepoFile).mockImplementation(async (_auth, path) => {
      if (typeof path === "string" && path.includes(PAPR_APP_CLOUD_REVISION_PATH)) {
        return { content: "rev-1\n", contentType: "text/plain" };
      }
      return null;
    });

    await fetchCachedRuntimeRepoFile(auth, "missing.tsx");
    await fetchCachedRuntimeRepoFile(auth, "missing.tsx");

    // No negative cache — second load still retries the file (revision marker cached briefly).
    expect(fetchRuntimeRepoFile).toHaveBeenCalledTimes(3);
  });

  it("uses per-app revision so apps do not share cache keys", async () => {
    const appA: AppRuntimeRouteAuth = { namespaceId: "ns-1", slug: "app-a" };
    const appB: AppRuntimeRouteAuth = { namespaceId: "ns-1", slug: "app-b" };

    vi.mocked(fetchRuntimeRepoFile).mockImplementation(async (runtimeAuth, path) => {
      if (typeof path === "string" && path.includes(PAPR_APP_CLOUD_REVISION_PATH)) {
        const revision = runtimeAuth.slug === "app-a" ? "hash-a\n" : "hash-b\n";
        return { content: revision, contentType: "text/plain" };
      }
      return {
        content: `bundle:${runtimeAuth.slug}`,
        contentType: "text/javascript",
      };
    });

    await fetchCachedRuntimeRepoFile(appA, "dist/app.js");
    await fetchCachedRuntimeRepoFile(appB, "dist/app.js");
    await fetchCachedRuntimeRepoFile(appA, "dist/app.js");

    // app-a: marker + file (cached on third call)
    // app-b: marker + file
    expect(fetchRuntimeRepoFile).toHaveBeenCalledTimes(4);
  });

  it("sets longer cache for dist assets", () => {
    expect(cacheControlForAppAsset("dist/app.js")).toContain("immutable");
    expect(cacheControlForAppAsset("index.html")).toContain("no-cache");
    expect(cacheControlForAppAsset("styles.css")).toContain("max-age=3600");
  });
});
