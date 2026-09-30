import { describe, expect, it } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";
import {
  extractDatabaseSlugFromPath,
  resolveReadableRegistryDbPath,
  workspaceRegistryDbPath,
} from "../src/gateway/services/resolveRegistryDbPath.js";
import { repairDataSourceDbPathsInConfig } from "../src/gateway/services/repairDataSourceDbPaths.js";

describe("resolveRegistryDbPath", () => {
  it("extracts slug from registry db path", () => {
    expect(
      extractDatabaseSlugFromPath(
        "/Users/me/Papr/data/databases/mfl-reports/data.db",
      ),
    ).toBe("mfl-reports");
  });

  it("rewrites flat path to workspace data dir when file exists there", async () => {
    const tempRoot = path.join(os.tmpdir(), `registry-db-${Date.now()}`);
    const dataDir = path.join(tempRoot, "data");
    const workspaceDb = workspaceRegistryDbPath("mfl-reports", dataDir);
    await fs.mkdir(path.dirname(workspaceDb), { recursive: true });
    await fs.writeFile(workspaceDb, "sqlite");

    const resolved = resolveReadableRegistryDbPath({
      dbPath: path.join(tempRoot, "data", "databases", "mfl-reports", "data.db"),
      dataDir,
    });

    expect(resolved).toBe(workspaceDb);

    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});

describe("repairDataSourceDbPathsInConfig registry sources", () => {
  it("repairs registry-backed source from sibling namespace copy", async () => {
    const tempRoot = path.join(os.tmpdir(), `registry-repair-${Date.now()}`);
    const orgId = "org1";
    const activeNs = "ns-active";
    const siblingNs = "ns-other";
    const activeHome = path.join(tempRoot, "orgs", orgId, "namespaces", activeNs);
    const siblingDb = path.join(
      tempRoot,
      "orgs",
      orgId,
      "namespaces",
      siblingNs,
      "data",
      "databases",
      "mfl-reports",
      "data.db",
    );
    await fs.mkdir(path.dirname(siblingDb), { recursive: true });
    await fs.writeFile(siblingDb, "sqlite-data");

    const flatPath = path.join(tempRoot, "data", "databases", "mfl-reports", "data.db");
    const originalEnv = process.env.PAPR_HOME;
    process.env.PAPR_HOME = activeHome;

    try {
      const { config, repairs } = await repairDataSourceDbPathsInConfig(
        "app-1",
        {
          sources: [
            {
              id: "db-1:main",
              type: "sqlite",
              dbId: "db-a6e43ae9",
              alias: "main",
              dbPath: flatPath,
              tables: [],
              linkedAt: new Date().toISOString(),
            },
          ],
        },
        { getJobDatabasePath: () => null },
      );

      expect(repairs).toHaveLength(1);
      expect(repairs[0]?.toPath).toContain(
        path.join("data", "databases", "mfl-reports", "data.db"),
      );
      expect(config.sources[0]?.dbPath).toBe(repairs[0]?.toPath);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.PAPR_HOME;
      } else {
        process.env.PAPR_HOME = originalEnv;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
