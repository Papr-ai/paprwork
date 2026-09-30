import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readDataSourceRegistryDbIds,
  resolveAppCloudSyncRelativePaths,
} from "../src/gateway/services/cloudSync/resolveAppDependentJobs.js";

describe("resolveAppCloudSyncRelativePaths", () => {
  it("returns only the app folder when app links registry databases", () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sync-paths-"));
    const appId = "app-deck";
    try {
      fs.mkdirSync(path.join(paprDir, "apps", appId), { recursive: true });
      fs.writeFileSync(
        path.join(paprDir, "apps", appId, "data-sources.json"),
        JSON.stringify(
          {
            sources: [
              {
                id: "db:decks",
                type: "sqlite",
                dbId: "db-2e4a46d7",
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

      expect(readDataSourceRegistryDbIds(paprDir, appId)).toEqual(["db-2e4a46d7"]);
      expect(resolveAppCloudSyncRelativePaths(paprDir, appId)).toEqual([
        path.join("apps", appId),
      ]);
    } finally {
      fs.rmSync(paprDir, { recursive: true, force: true });
    }
  });
});
