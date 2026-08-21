import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAppDataSourcesConfig } from "../src/gateway/services/appRuntime/cloudDatabaseRegistry.js";
import { resetCloudAppHostCachesForTests } from "../src/gateway/services/appRuntime/cloudAppHostCache.js";
import type { AppRuntimeRouteAuth } from "../src/gateway/services/appRuntime/types.js";
import { PAPR_APP_CLOUD_REVISION_PATH } from "../src/gateway/services/cloudSync/cloudAppRevisionMarker.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

vi.mock("../src/gateway/services/appRuntime/memoryRuntimeClient.js", () => ({
  fetchRuntimeRepoFile: vi.fn(),
}));

import { fetchRuntimeRepoFile } from "../src/gateway/services/appRuntime/memoryRuntimeClient.js";

useIsolatedPaprWorkspace("cloud-database-registry");

const auth: AppRuntimeRouteAuth = {
  namespaceId: "ns-1",
  slug: "my-app",
};

afterEach(() => {
  resetCloudAppHostCachesForTests();
  vi.clearAllMocks();
});

describe("loadAppDataSourcesConfig", () => {
  it("fetches data-sources, linked-databases, and databases.json in parallel", async () => {
    const callOrder: string[] = [];

    vi.mocked(fetchRuntimeRepoFile).mockImplementation(async (_auth, path) => {
      if (typeof path === "string" && path.includes(PAPR_APP_CLOUD_REVISION_PATH)) {
        return { content: "rev-1\n", contentType: "text/plain" };
      }
      callOrder.push(String(path));
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (path === "data-sources.json") {
        return {
          content: JSON.stringify({
            sources: [{ alias: "main", jobId: "job-1", dbPath: "data/data.db" }],
          }),
          contentType: "application/json",
        };
      }
      if (path === "linked-databases.json") {
        return { content: JSON.stringify({ databases: {} }), contentType: "application/json" };
      }
      if (path === "data/databases.json") {
        return { content: JSON.stringify({ databases: {} }), contentType: "application/json" };
      }
      return null;
    });

    const config = await loadAppDataSourcesConfig(auth);

    expect(config.sources).toHaveLength(1);
    expect(config.sources[0]?.alias).toBe("main");
    // All three config files start fetching before any completes (~parallel).
    expect(callOrder.slice(0, 3).sort()).toEqual(
      ["data-sources.json", "data/databases.json", "linked-databases.json"].sort(),
    );
  });

  it("caches parsed app db config keyed by revision (Phase 3.3)", async () => {
    vi.mocked(fetchRuntimeRepoFile).mockImplementation(async (_auth, path) => {
      if (typeof path === "string" && path.includes(PAPR_APP_CLOUD_REVISION_PATH)) {
        return { content: "rev-1\n", contentType: "text/plain" };
      }
      if (path === "data-sources.json") {
        return {
          content: JSON.stringify({
            sources: [{ alias: "main", jobId: "job-1", dbPath: "data/data.db" }],
          }),
          contentType: "application/json",
        };
      }
      if (path === "linked-databases.json") {
        return { content: JSON.stringify({ databases: {} }), contentType: "application/json" };
      }
      if (path === "data/databases.json") {
        return { content: JSON.stringify({ databases: {} }), contentType: "application/json" };
      }
      return null;
    });

    const stats1 = { cacheHit: false as boolean | undefined };
    await loadAppDataSourcesConfig(auth, "data-sources.json", stats1);
    expect(stats1.cacheHit).toBe(false);

    const stats2 = { cacheHit: false as boolean | undefined };
    await loadAppDataSourcesConfig(auth, "data-sources.json", stats2);
    expect(stats2.cacheHit).toBe(true);

    // Revision marker + 3 files on first load only.
    expect(fetchRuntimeRepoFile).toHaveBeenCalledTimes(4);
  });

  it("does not cache empty config when data-sources.json is missing", async () => {
    vi.mocked(fetchRuntimeRepoFile).mockImplementation(async (_auth, path) => {
      if (typeof path === "string" && path.includes(PAPR_APP_CLOUD_REVISION_PATH)) {
        return { content: "rev-1\n", contentType: "text/plain" };
      }
      if (path === "data-sources.json") {
        return null;
      }
      if (path === "linked-databases.json") {
        return {
          content: JSON.stringify({
            version: 1,
            databases: { "db-1": { dbId: "db-1", label: "main" } },
          }),
          contentType: "application/json",
        };
      }
      if (path === "data/databases.json") {
        return { content: JSON.stringify({ databases: {} }), contentType: "application/json" };
      }
      return null;
    });

    const stats1 = { cacheHit: false as boolean | undefined };
    const first = await loadAppDataSourcesConfig(auth, "data-sources.json", stats1);
    expect(first.sources).toHaveLength(0);
    expect(stats1.cacheHit).toBe(false);

    vi.mocked(fetchRuntimeRepoFile).mockImplementation(async (_auth, path) => {
      if (typeof path === "string" && path.includes(PAPR_APP_CLOUD_REVISION_PATH)) {
        return { content: "rev-1\n", contentType: "text/plain" };
      }
      if (path === "data-sources.json") {
        return {
          content: JSON.stringify({
            sources: [{ alias: "main", jobId: "job-1", dbPath: "data/data.db" }],
          }),
          contentType: "application/json",
        };
      }
      if (path === "linked-databases.json") {
        return {
          content: JSON.stringify({ version: 1, databases: {} }),
          contentType: "application/json",
        };
      }
      if (path === "data/databases.json") {
        return { content: JSON.stringify({ databases: {} }), contentType: "application/json" };
      }
      return null;
    });

    const stats2 = { cacheHit: false as boolean | undefined };
    const second = await loadAppDataSourcesConfig(auth, "data-sources.json", stats2);
    expect(second.sources).toHaveLength(1);
    expect(stats2.cacheHit).toBe(false);
  });
});
