import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import {
  buildJobDatabasePathIndex,
  createJobPathResolverForDataSourcesFile,
} from "../src/gateway/services/jobDatabasePathIndex.js";
import {
  discoverDataSourcesFiles,
  runGlobalDataSourcePathRepair,
} from "../src/gateway/services/dataSourcePathRepairScan.js";

describe("buildJobDatabasePathIndex", () => {
  it("indexes flat and namespace-scoped job databases", async () => {
    const root = path.join(os.tmpdir(), `papr-index-${Date.now()}`);
    const jobFlat = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const jobNs = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const flatDb = path.join(root, "Jobs", jobFlat, "data", "data.db");
    mkdirSync(path.dirname(flatDb), { recursive: true });
    writeFileSync(flatDb, "");

    const nsDb = path.join(
      root,
      "orgs",
      "org1",
      "namespaces",
      "ns1",
      "Jobs",
      jobNs,
      "data",
      "data.db",
    );
    mkdirSync(path.dirname(nsDb), { recursive: true });
    writeFileSync(nsDb, "");

    const index = await buildJobDatabasePathIndex(root);

    expect(index.get(jobFlat)).toBe(flatDb);
    expect(index.get(jobNs)).toBe(nsDb);
  });
});

describe("runGlobalDataSourcePathRepair", () => {
  it("repairs stale dbPath in discovered data-sources.json files", async () => {
    const root = path.join(os.tmpdir(), `papr-scan-${Date.now()}`);
    const jobId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const appId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const canonical = path.join(root, "Jobs", jobId, "data", "data.db");
    mkdirSync(path.dirname(canonical), { recursive: true });
    writeFileSync(canonical, "");

    const dataSourcesPath = path.join(root, "apps", appId, "data-sources.json");
    mkdirSync(path.dirname(dataSourcesPath), { recursive: true });
    writeFileSync(
      dataSourcesPath,
      JSON.stringify(
        {
          sources: [
            {
              id: `${jobId}:sync`,
              type: "sqlite",
              jobId,
              alias: "sync",
              dbPath: path.join(os.homedir(), "Papr", "jobs", jobId, "data", "data.db"),
              tables: [],
              linkedAt: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
    );

    const files = await discoverDataSourcesFiles(root);
    expect(files).toContain(dataSourcesPath);

    const result = await runGlobalDataSourcePathRepair({
      paprBase: root,
      delayMs: 0,
    });

    expect(result.repairCount).toBe(1);
    expect(result.repairedApps).toBe(1);

    const updated = JSON.parse(
      await import("fs/promises").then((fs) =>
        fs.readFile(dataSourcesPath, "utf8"),
      ),
    ) as { sources: Array<{ dbPath: string }> };

    expect(updated.sources[0]?.dbPath).toBe(canonical);
    expect(existsSync(canonical)).toBe(true);

    const resolver = createJobPathResolverForDataSourcesFile(
      dataSourcesPath,
      root,
      await buildJobDatabasePathIndex(root),
    );
    expect(resolver.getJobDatabasePath(jobId)).toBe(canonical);
  });
});
