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

