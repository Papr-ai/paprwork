import { describe, expect, it } from "vitest";
import path from "path";
import {
  scrubDataSourcesForPortableSync,
  resolveLinkedSourceDbPath,
} from "../src/gateway/services/portableDataSources.js";
import type { AppDataSourcesFile } from "../src/gateway/services/appDataSources.js";
import { resetDatabaseRegistryForWorkspaceSwitch } from "../src/gateway/services/DatabaseRegistryService.js";
import { getPaprJobsRoot } from "../src/core/utils/paprRoot.js";

describe("portableDataSources", () => {
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
});
