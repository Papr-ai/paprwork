import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeLinkedDatabasesForApp } from "../src/gateway/services/cloudSync/linkedDatabasesForCloud.js";
import { resetDatabaseRegistryForWorkspaceSwitch } from "../src/gateway/services/DatabaseRegistryService.js";
import { dbTursoDatabaseName } from "../src/gateway/services/tursoDatabaseNaming.js";

describe("writeLinkedDatabasesForApp", () => {
  let previousPaprHome: string | undefined;

  beforeEach(() => {
    resetDatabaseRegistryForWorkspaceSwitch();
    previousPaprHome = process.env.PAPR_HOME;
  });

  afterEach(() => {
    resetDatabaseRegistryForWorkspaceSwitch();
    if (previousPaprHome === undefined) {
      delete process.env.PAPR_HOME;
    } else {
      process.env.PAPR_HOME = previousPaprHome;
    }
  });

  it("exports registry records for dbIds in data-sources.json", async () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-linked-db-"));
    process.env.PAPR_HOME = paprDir;
    const appId = "app-deck";
    const dbId = "db-2e4a46d7";
    try {
      const dataDir = path.join(paprDir, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, "databases.json"),
        JSON.stringify(
          {
            version: 1,
            databases: {
              [dbId]: {
                dbId,
                localPath: "/tmp/decks/data.db",
                tursoShortName: dbTursoDatabaseName(dbId),
                isolation: "shared",
                status: "active",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const appDir = path.join(paprDir, "apps", appId);
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(
        path.join(appDir, "data-sources.json"),
        JSON.stringify(
          {
            sources: [
              {
                id: "db:decks",
                type: "sqlite",
                dbId,
                alias: "decks",
                dbPath: "/tmp/decks/data.db",
                tables: [],
                linkedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = await writeLinkedDatabasesForApp(paprDir, appId);
      expect(result.dbIds).toEqual([dbId]);
      expect(result.missingDbIds).toEqual([]);
      expect(result.written).toBe(true);

      const linked = JSON.parse(
        fs.readFileSync(path.join(appDir, "linked-databases.json"), "utf8"),
      ) as {
        databases: Record<string, { dbId: string; localPath: string; tursoShortName: string }>;
      };
      expect(linked.databases[dbId]?.tursoShortName).toBe(dbTursoDatabaseName(dbId));
      expect(linked.databases[dbId]?.localPath).toBe("");
    } finally {
      fs.rmSync(paprDir, { recursive: true, force: true });
    }
  });
});
