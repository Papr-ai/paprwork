import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import {
  canonicalJobDatabasePath,
  isPathWithinWorkspace,
  resolveDataSourcesForWorkspace,
  resolveJobLinkedSourceForWorkspace,
} from "../src/gateway/services/appDataSources.js";
import { scanLegacyPathHealth } from "../src/gateway/services/legacyPathHealthScan.js";

describe("namespace-scoped job-linked data sources", () => {
  it("resolves dbPath from active workspace Jobs tree when job exists locally", () => {
    const tempRoot = path.join(os.tmpdir(), `papr-ns-scope-${Date.now()}`);
    const activeHome = path.join(tempRoot, "orgs", "my-org", "namespaces", "my-ns");
    const otherHome = path.join(tempRoot, "orgs", "other-org", "namespaces", "other-ns");
    const jobId = "2cafb2e9-696b-42db-98fa-5d605977123c";
    const jobsRoot = path.join(activeHome, "Jobs");
    const localDb = canonicalJobDatabasePath(jobsRoot, jobId);
    const foreignDb = canonicalJobDatabasePath(path.join(otherHome, "Jobs"), jobId);

    mkdirSync(path.dirname(localDb), { recursive: true });
    writeFileSync(localDb, "");

    const resolved = resolveJobLinkedSourceForWorkspace(
      {
        id: "s1",
        type: "sqlite",
        jobId,
        alias: "Daily Brief",
        dbPath: foreignDb,
        tables: [],
        linkedAt: new Date().toISOString(),
      },
      jobsRoot,
    );

    expect(resolved.dbPath).toBe(localDb);
    expect(existsSync(resolved.dbPath)).toBe(true);
  });

  it("keeps stored dbPath when job database is missing in active workspace", () => {
    const tempRoot = path.join(os.tmpdir(), `papr-ns-missing-${Date.now()}`);
    const activeHome = path.join(tempRoot, "orgs", "my-org", "namespaces", "my-ns");
    const otherHome = path.join(tempRoot, "orgs", "other-org", "namespaces", "other-ns");
    const jobId = "2cafb2e9-696b-42db-98fa-5d605977123c";
    const foreignDb = canonicalJobDatabasePath(path.join(otherHome, "Jobs"), jobId);

    mkdirSync(path.dirname(foreignDb), { recursive: true });
    writeFileSync(foreignDb, "");

    const source = {
      id: "s1",
      type: "sqlite" as const,
      jobId,
      alias: "Daily Brief",
      dbPath: foreignDb,
      tables: [] as string[],
      linkedAt: new Date().toISOString(),
    };

    const resolved = resolveJobLinkedSourceForWorkspace(
      source,
      path.join(activeHome, "Jobs"),
    );

    expect(resolved.dbPath).toBe(foreignDb);
  });

  it("does not flag stale dbPath when local job folder exists in active workspace", async () => {
    const tempRoot = path.join(os.tmpdir(), `papr-health-ns-${Date.now()}`);
    const activeHome = path.join(tempRoot, "orgs", "active-org", "namespaces", "active-ns");
    const staleHome = path.join(tempRoot, "orgs", "stale-org", "namespaces", "stale-ns");
    const appId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
    const jobId = "2cafb2e9-696b-42db-98fa-5d605977123c";
    const activeDbPath = canonicalJobDatabasePath(path.join(activeHome, "Jobs"), jobId);
    const staleDbPath = canonicalJobDatabasePath(path.join(staleHome, "Jobs"), jobId);
    const appPath = path.join(activeHome, "apps", appId);
    const jobsRoot = path.join(activeHome, "Jobs");

    await import("fs/promises").then(async (fs) => {
      await fs.mkdir(path.dirname(activeDbPath), { recursive: true });
      await fs.writeFile(activeDbPath, "", "utf8");
      await fs.mkdir(path.dirname(staleDbPath), { recursive: true });
      await fs.writeFile(staleDbPath, "", "utf8");
      await fs.mkdir(appPath, { recursive: true });
      await fs.writeFile(
        path.join(appPath, "data-sources.json"),
        JSON.stringify({
          sources: [
            {
              id: "s1",
              type: "sqlite",
              alias: "Daily Brief Generator",
              jobId,
              dbPath: staleDbPath,
            },
          ],
        }),
        "utf8",
      );
    });

    const result = await scanLegacyPathHealth({
      jobs: [],
      apps: [{ id: appId, title: "Home" }],
      jobsRoot,
      appsRoot: path.join(activeHome, "apps"),
      paprBase: tempRoot,
      activePaprHome: activeHome,
    });

    expect(result.appIssueCount).toBe(0);

    await import("fs/promises").then((fs) =>
      fs.rm(tempRoot, { recursive: true, force: true }),
    );
  });

  it("detects paths outside workspace root", () => {
    const workspace = path.join(os.homedir(), "Papr", "orgs", "o1", "namespaces", "n1");
    const inside = path.join(workspace, "Jobs", "job-1", "data", "data.db");
    const outside = path.join(os.homedir(), "Papr", "orgs", "o2", "namespaces", "n2", "Jobs", "job-1", "data", "data.db");

    expect(isPathWithinWorkspace(inside, workspace)).toBe(true);
    expect(isPathWithinWorkspace(outside, workspace)).toBe(false);
  });

  it("resolves all sources in a config file", () => {
    const jobsRoot = path.join(os.tmpdir(), `papr-config-${Date.now()}`, "Jobs");
    const jobId = "11111111-1111-1111-1111-111111111111";
    const localDb = canonicalJobDatabasePath(jobsRoot, jobId);
    mkdirSync(path.dirname(localDb), { recursive: true });
    writeFileSync(localDb, "");

    const resolved = resolveDataSourcesForWorkspace(
      {
        sources: [
          {
            id: "s1",
            type: "sqlite",
            jobId,
            alias: "sync",
            dbPath: "/other/namespace/data.db",
            tables: [],
            linkedAt: new Date().toISOString(),
          },
        ],
      },
      jobsRoot,
    );

    expect(resolved.sources[0]?.dbPath).toBe(localDb);
  });
});
