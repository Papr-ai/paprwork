import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { repairDataSourceDbPathsInConfig } from "../src/gateway/services/repairDataSourceDbPaths.js";
import type { AppDataSourcesFile } from "../src/gateway/services/appDataSources.js";

describe("repairDataSourceDbPathsInConfig", () => {
  it("rewrites stale job dbPath to canonical workspace path when job exists", async () => {
    const root = path.join(os.tmpdir(), `papr-repair-${Date.now()}`);
    const jobId = "11111111-1111-1111-1111-111111111111";
    const canonical = path.join(root, "Jobs", jobId, "data", "data.db");
    mkdirSync(path.dirname(canonical), { recursive: true });
    writeFileSync(canonical, "");

    const stalePath = path.join(os.homedir(), "Papr", "jobs", jobId, "data", "data.db");
    const config: AppDataSourcesFile = {
      primary: "sync",
      sources: [
        {
          id: `${jobId}:sync`,
          type: "sqlite",
          jobId,
          alias: "sync",
          dbPath: stalePath,
          tables: [],
          linkedAt: new Date().toISOString(),
        },
      ],
    };

    const jobsService = {
      getJobDatabasePath: async (id: string) =>
        id === jobId ? canonical : null,
    };

    const result = await repairDataSourceDbPathsInConfig(
      "app-1",
      config,
      jobsService as never,
    );

    expect(result.repairs).toHaveLength(1);
    expect(result.config.sources[0]?.dbPath).toBe(canonical);
    expect(existsSync(canonical)).toBe(true);
  });

  it("rewrites cross-namespace dbPath when canonical job db exists in active workspace", async () => {
    const paprBase = path.join(os.tmpdir(), `papr-cross-ns-${Date.now()}`);
    const activeHome = path.join(paprBase, "orgs", "active-org", "namespaces", "active-ns");
    const siblingHome = path.join(paprBase, "orgs", "other-org", "namespaces", "other-ns");
    const jobId = "22222222-2222-2222-2222-222222222222";
    const canonical = path.join(activeHome, "Jobs", jobId, "data", "data.db");
    const siblingDb = path.join(siblingHome, "Jobs", jobId, "data", "data.db");
    mkdirSync(path.dirname(canonical), { recursive: true });
    mkdirSync(path.dirname(siblingDb), { recursive: true });
    writeFileSync(canonical, "active");
    writeFileSync(siblingDb, "sibling");

    const config: AppDataSourcesFile = {
      sources: [
        {
          id: `${jobId}:brief`,
          type: "sqlite",
          jobId,
          alias: "Daily Brief",
          dbPath: siblingDb,
          tables: [],
          linkedAt: new Date().toISOString(),
        },
      ],
    };

    const jobsService = {
      getJobDatabasePath: async (id: string) =>
        id === jobId ? canonical : null,
    };

    const result = await repairDataSourceDbPathsInConfig(
      "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c",
      config,
      jobsService as never,
    );

    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]?.fromPath).toBe(siblingDb);
    expect(result.repairs[0]?.toPath).toBe(canonical);
    expect(result.config.sources[0]?.dbPath).toBe(canonical);
  });

  it("leaves config unchanged when stored path already matches canonical", async () => {
    const canonical = path.join(os.tmpdir(), "already-correct.db");
    const config: AppDataSourcesFile = {
      sources: [
        {
          id: "x",
          type: "sqlite",
          jobId: "job-1",
          alias: "primary",
          dbPath: canonical,
          tables: [],
          linkedAt: new Date().toISOString(),
        },
      ],
    };

    const jobsService = {
      getJobDatabasePath: async () => canonical,
    };

    const result = await repairDataSourceDbPathsInConfig(
      "app-1",
      config,
      jobsService as never,
    );

    expect(result.repairs).toHaveLength(0);
    expect(result.config).toEqual(config);
  });
});
