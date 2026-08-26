import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import {
  buildLinkedRegistryDbPreview,
  deleteSoleLinkerRegistryDatabases,
} from "../src/gateway/services/deleteAppLinkedDatabases.js";
import { initializeDatabaseRegistry, resetDatabaseRegistryForWorkspaceSwitch } from "../src/gateway/services/DatabaseRegistryService.js";

describe("deleteAppLinkedDatabases", () => {
  const workspace = useIsolatedPaprWorkspace("delete-app-linked-dbs");

  beforeEach(async () => {
    resetDatabaseRegistryForWorkspaceSwitch();
    await initializeDatabaseRegistry();
  });

  function writeAppDataSources(
    appId: string,
    appTitle: string,
    dbId: string,
    dbPath: string,
    alias: string,
  ): void {
    const appsRoot = path.join(workspace.paprHome, "apps");
    const appDir = path.join(appsRoot, appId);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "data-sources.json"),
      JSON.stringify({
        primary: alias,
        sources: [
          {
            id: `${dbId}:${alias}`,
            type: "sqlite",
            dbId,
            alias,
            dbPath,
            tables: [],
            linkedAt: "2026-01-01T00:00:00.000Z",
            role: "primary",
          },
        ],
      }),
    );
    fs.mkdirSync(path.join(workspace.paprHome, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace.paprHome, "data", "apps.json"),
      JSON.stringify([
        { id: appId, title: appTitle, type: "mini-app", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );
  }

  async function registerDb(
    dbId: string,
    dbPath: string,
    label: string,
  ): Promise<void> {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "sqlite");
    const registry = await initializeDatabaseRegistry();
    await registry.register({
      dbId,
      localPath: dbPath,
      label,
      tursoShortName: `d-${dbId.slice(3, 11)}`,
    });
  }

  it("marks shared registry DBs and lists other apps", async () => {
    const dbId = "db-shared99";
    const dbPath = path.join(
      workspace.paprHome,
      "data",
      "databases",
      "shared",
      "data.db",
    );
    await registerDb(dbId, dbPath, "Shared SQA");

    writeAppDataSources("app-a", "SQA Command Center", dbId, dbPath, "sqa");
    writeAppDataSources("app-b", "Talent Assessment", dbId, dbPath, "sqa");

    const previews = await buildLinkedRegistryDbPreview(
      "app-a",
      path.join(workspace.paprHome, "apps"),
      (id) => (id === "app-b" ? "Talent Assessment" : id),
    );

    expect(previews).toHaveLength(1);
    expect(previews[0]?.soleLinker).toBe(false);
    expect(previews[0]?.sharedWithApps).toEqual([
      { appId: "app-b", title: "Talent Assessment" },
    ]);
  });

  it("marks sole-linker registry DBs for optional deletion", async () => {
    const dbId = "db-solelink";
    const dbPath = path.join(
      workspace.paprHome,
      "data",
      "databases",
      "solo",
      "data.db",
    );
    await registerDb(dbId, dbPath, "Solo DB");

    writeAppDataSources("app-only", "Only App", dbId, dbPath, "main");

    const previews = await buildLinkedRegistryDbPreview(
      "app-only",
      path.join(workspace.paprHome, "apps"),
      () => "Other",
    );

    expect(previews).toHaveLength(1);
    expect(previews[0]?.soleLinker).toBe(true);
    expect(previews[0]?.sharedWithApps).toEqual([]);
  });

  it("deletes sole-linker registry DB locally and tombstones registry", async () => {
    const dbId = "db-deleteme";
    const dbPath = path.join(
      workspace.paprHome,
      "data",
      "databases",
      "deleteme",
      "data.db",
    );
    await registerDb(dbId, dbPath, "Delete Me");
    writeAppDataSources("app-del", "Delete App", dbId, dbPath, "main");

    const result = await deleteSoleLinkerRegistryDatabases(
      "app-del",
      [dbId],
      false,
    );

    expect(result.deletedRegistryDbCount).toBe(1);
    expect(fs.existsSync(dbPath)).toBe(false);

    const registryRaw = fs.readFileSync(
      path.join(workspace.paprHome, "data", "databases.json"),
      "utf8",
    );
    const registryJson = JSON.parse(registryRaw) as {
      databases: Record<string, { status?: string }>;
    };
    expect(registryJson.databases[dbId]?.status).toBe("tombstone");
  });

  it("refuses to delete registry DB still linked by another app", async () => {
    const dbId = "db-protected";
    const dbPath = path.join(
      workspace.paprHome,
      "data",
      "databases",
      "protected",
      "data.db",
    );
    await registerDb(dbId, dbPath, "Protected");
    writeAppDataSources("app-a", "App A", dbId, dbPath, "sqa");
    writeAppDataSources("app-b", "App B", dbId, dbPath, "sqa");

    const result = await deleteSoleLinkerRegistryDatabases(
      "app-a",
      [dbId],
      false,
    );

    expect(result.deletedRegistryDbCount).toBe(0);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
