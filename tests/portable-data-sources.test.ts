import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import {
  scrubDataSourcesForPortableSync,
  resolveLinkedSourceDbPath,
} from "../src/gateway/services/portableDataSources.js";
import type { AppDataSourcesFile } from "../src/gateway/services/appDataSources.js";
import { resetDatabaseRegistryForWorkspaceSwitch } from "../src/gateway/services/DatabaseRegistryService.js";
import { getPaprJobsRoot } from "../src/core/utils/paprRoot.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

describe("portableDataSources", () => {
  // Keeps fixtures out of the developer's real ~/Papr workspace.
  useIsolatedPaprWorkspace("portable-data-sources");

  it("scrubDataSourcesForPortableSync clears dbPath but keeps dbId", () => {
    const config: AppDataSourcesFile = {
      sources: [
        {
          id: "gtm:main",
          type: "sqlite",
          dbId: "db-7c4c3837",
          alias: "gtm",
          dbPath: "/Users/publisher/Papr/data/databases/myadvice-gtm-metrics/data.db",
          tables: [],
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    const scrubbed = scrubDataSourcesForPortableSync(config);
    expect(scrubbed.sources[0]?.dbPath).toBe("");
    expect(scrubbed.sources[0]?.dbId).toBe("db-7c4c3837");
  });

  it("resolveLinkedSourceDbPath maps foreign registry path to local workspace slug path", async () => {
    resetDatabaseRegistryForWorkspaceSwitch();

    const foreignPath =
      "/Users/other-user/Papr/orgs/x/namespaces/y/data/databases/myadvice-gtm-metrics/data.db";

    const resolved = await resolveLinkedSourceDbPath({
      dbPath: foreignPath,
      dbId: "db-7c4c3837",
      jobsRoot: path.join(getPaprJobsRoot()),
    });

    expect(resolved).toContain(
      `${path.sep}data${path.sep}databases${path.sep}myadvice-gtm-metrics${path.sep}data.db`,
    );
    expect(resolved).not.toContain("/Users/other-user/");
  });

  it("resolveLinkedSourceDbPath resolves empty dbPath via registry label slug", async () => {
    resetDatabaseRegistryForWorkspaceSwitch();

    const dataDir = path.join(getPaprJobsRoot(), "..", "data");
    const slugDir = path.join(dataDir, "databases", "joe-coffee-intelligence");
    await fs.mkdir(slugDir, { recursive: true });
    const dbPath = path.join(slugDir, "data.db");
    await fs.writeFile(dbPath, Buffer.alloc(4096));

    const { getDatabaseRegistryService } = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
    getDatabaseRegistryService().mergeFromRegistryFile(
      JSON.stringify({
        version: 1,
        databases: {
          "db-0ff146f4": {
            dbId: "db-0ff146f4",
            localPath: "",
            tursoShortName: "d-0ff146f4",
            label: "Joe Coffee Intelligence",
            isolation: "shared",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const resolved = await resolveLinkedSourceDbPath({
      dbPath: "",
      dbId: "db-0ff146f4",
      jobsRoot: getPaprJobsRoot(),
      registryLabel: "Joe Coffee Intelligence",
    });

    expect(resolved).toBe(dbPath);
  });
});
