import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  mergeDatabaseRegistryForCopy,
  syncAppLinkedResourcesToTarget,
} from "../src/gateway/services/copyAppToNamespace.js";

describe("cloud install fork registry", () => {
  let targetHome: string;
  let sourceHome: string;
  let localAppId: string;
  const publisherDbId = "db-7c4c3837";

  beforeEach(async () => {
    localAppId = randomUUID();
    sourceHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-fork-src-"));
    targetHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-fork-tgt-"));

    await fs.mkdir(path.join(targetHome, "apps", localAppId), {
      recursive: true,
    });
    await fs.mkdir(path.join(targetHome, "data"), { recursive: true });
    await fs.mkdir(path.join(sourceHome, "data", "databases", "gtm-metrics"), {
      recursive: true,
    });

    await fs.writeFile(
      path.join(sourceHome, "data", "databases", "gtm-metrics", "data.db"),
      "publisher-row-data",
    );
    await fs.mkdir(
      path.join(sourceHome, "data", "databases", "gtm-metrics", "migrations"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(
        sourceHome,
        "data",
        "databases",
        "gtm-metrics",
        "migrations",
        "001_init.sql",
      ),
      "CREATE TABLE items (id INTEGER PRIMARY KEY);",
    );

    await fs.writeFile(
      path.join(sourceHome, "data", "databases.json"),
      JSON.stringify({
        version: 1,
        databases: {
          [publisherDbId]: {
            dbId: publisherDbId,
            localPath: path.join(
              sourceHome,
              "data/databases/gtm-metrics/data.db",
            ),
            tursoShortName: "d-7c4c3837",
            label: "GTM Metrics",
            isolation: "shared",
            syncMode: "replica",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    await fs.writeFile(
      path.join(targetHome, "apps", localAppId, "data-sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: `${publisherDbId}:gtm`,
              type: "sqlite",
              dbId: publisherDbId,
              alias: "gtm",
              dbPath: path.join(
                sourceHome,
                "data/databases/gtm-metrics/data.db",
              ),
              tables: [],
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(targetHome, "data", "jobs.json"),
      JSON.stringify([]),
    );
  });

  afterEach(async () => {
    await fs.rm(sourceHome, { recursive: true, force: true });
    await fs.rm(targetHome, { recursive: true, force: true });
  });

  it("mergeDatabaseRegistryForCopy mints new dbId when forkDbIds is true", async () => {
    const targetAppDir = path.join(targetHome, "apps", localAppId);
    const targetRegistryPath = path.join(targetHome, "data", "databases.json");

    const { registryDbIds, dbIdRemap } = await mergeDatabaseRegistryForCopy({
      sourceRegistryPath: path.join(sourceHome, "data", "databases.json"),
      targetRegistryPath,
      targetPaprHome: targetHome,
      copiedJobIds: new Set(),
      dbIdsFromJobs: new Set(),
      appDir: targetAppDir,
      forkDbIds: true,
      localAppId,
    });

    expect(registryDbIds.size).toBe(1);
    expect(dbIdRemap.size).toBe(1);
    expect(dbIdRemap.has(publisherDbId)).toBe(true);

    const newDbId = dbIdRemap.get(publisherDbId)!;
    expect(newDbId).not.toBe(publisherDbId);
    expect(registryDbIds.has(newDbId)).toBe(true);

    const registryRaw = await fs.readFile(targetRegistryPath, "utf8");
    const registry = JSON.parse(registryRaw) as {
      databases: Record<
        string,
        { dbId: string; schemaOwnerAppId?: string; tursoShortName: string }
      >;
    };
    expect(registry.databases[publisherDbId]).toBeUndefined();
    expect(registry.databases[newDbId]?.schemaOwnerAppId).toBe(localAppId);
    expect(registry.databases[newDbId]?.tursoShortName).toMatch(/^d-[a-f0-9]{8}$/);
  });

  it("syncAppLinkedResourcesToTarget shared_primary keeps dbId but skips publisher data.db", async () => {
    const result = await syncAppLinkedResourcesToTarget({
      appId: localAppId,
      sourcePaprHome: sourceHome,
      targetPaprHome: targetHome,
      installDbPolicy: "shared_primary",
    });

    expect(result.registryDbIds).toEqual([publisherDbId]);

    const dsRaw = await fs.readFile(
      path.join(targetHome, "apps", localAppId, "data-sources.json"),
      "utf8",
    );
    const ds = JSON.parse(dsRaw) as {
      sources: Array<{ dbId?: string }>;
    };
    expect(ds.sources[0]?.dbId).toBe(publisherDbId);

    const slugDir = path.join(targetHome, "data", "databases", "gtm-metrics");
    await expect(fs.access(path.join(slugDir, "data.db"))).rejects.toThrow();
    await expect(
      fs.access(path.join(slugDir, "migrations", "001_init.sql")),
    ).resolves.toBeUndefined();
  });

  it("syncAppLinkedResourcesToTarget jobs_and_code skips registry SQLite copies", async () => {
    const localMarker = "local-only-row-data";
    const slugDir = path.join(targetHome, "data", "databases", "gtm-metrics");
    await fs.mkdir(slugDir, { recursive: true });
    await fs.writeFile(path.join(slugDir, "data.db"), localMarker);

    const result = await syncAppLinkedResourcesToTarget({
      appId: localAppId,
      sourcePaprHome: sourceHome,
      targetPaprHome: targetHome,
      syncScope: "jobs_and_code",
    });

    expect(result.registryDbIds).toEqual([]);
    expect(result.copiedRegistryDbSlugs).toEqual([]);

    const localDb = await fs.readFile(path.join(slugDir, "data.db"), "utf8");
    expect(localDb).toBe(localMarker);
  });

  it("syncAppLinkedResourcesToTarget fork_empty skips publisher data.db bytes", async () => {
    const result = await syncAppLinkedResourcesToTarget({
      appId: localAppId,
      sourcePaprHome: sourceHome,
      targetPaprHome: targetHome,
      installDbPolicy: "fork_empty",
    });

    expect(result.registryDbIds.length).toBe(1);
    const newDbId = result.registryDbIds[0]!;
    expect(newDbId).not.toBe(publisherDbId);

    const dsRaw = await fs.readFile(
      path.join(targetHome, "apps", localAppId, "data-sources.json"),
      "utf8",
    );
    const ds = JSON.parse(dsRaw) as {
      sources: Array<{ dbId?: string; id?: string }>;
    };
    expect(ds.sources[0]?.dbId).toBe(newDbId);
    expect(ds.sources[0]?.id).toContain(newDbId);

    const slugDir = path.join(targetHome, "data", "databases", "gtm-metrics");
    const dataDbPath = path.join(slugDir, "data.db");
    await expect(fs.access(dataDbPath)).rejects.toThrow();

    const migrationsPath = path.join(slugDir, "migrations", "001_init.sql");
    await expect(fs.access(migrationsPath)).resolves.toBeUndefined();

    const registryRaw = await fs.readFile(
      path.join(targetHome, "data", "databases.json"),
      "utf8",
    );
    const registry = JSON.parse(registryRaw) as {
      databases: Record<string, { syncMode?: string }>;
    };
    expect(registry.databases[newDbId]?.syncMode).toBeUndefined();
  });
});
