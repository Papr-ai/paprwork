import { describe, expect, it, beforeEach } from "vitest";
import {
  DatabaseRegistryService,
  dbIdFromPath,
  resetDatabaseRegistryForWorkspaceSwitch,
} from "../src/gateway/services/DatabaseRegistryService.js";
import type { AppDataSource } from "../src/gateway/services/appDataSources.js";
import { dbTursoDatabaseName } from "../src/gateway/services/tursoDatabaseNaming.js";

describe("DatabaseRegistryService cloud hydration", () => {
  beforeEach(() => {
    resetDatabaseRegistryForWorkspaceSwitch();
  });

  it("mergeFromRegistryFile loads synced databases.json entries", () => {
    const registry = new DatabaseRegistryService("/tmp/papr-data", "/tmp/papr-apps");
    const dbPath = "/Users/me/Papr/data/databases/myapp/data.db";
    const dbId = dbIdFromPath(dbPath);

    const merged = registry.mergeFromRegistryFile(
      JSON.stringify({
        version: 1,
        databases: {
          [dbId]: {
            dbId,
            localPath: dbPath,
            tursoShortName: dbTursoDatabaseName(dbId),
            isolation: "shared",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      }),
    );

    expect(merged).toBe(1);
    expect(registry.getById(dbId)?.localPath).toBe(dbPath);
  });

  it("ensureRecordForSource synthesizes shared record when registry empty", () => {
    const registry = new DatabaseRegistryService("/tmp/papr-data", "/tmp/papr-apps");
    const dbPath = "/Users/me/Papr/data/databases/fetch-job/data.db";
    const source: AppDataSource = {
      id: "job:main",
      type: "sqlite",
      jobId: "a5b67ed7-2372-42af-bc39-59570f1455b9",
      dbId: dbIdFromPath(dbPath),
      alias: "Fetch Meetings",
      dbPath,
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    };

    const record = registry.ensureRecordForSource(source);
    expect(record.dbId).toBe(source.dbId);
    expect(record.isolation).toBe("shared");
    expect(registry.getById(source.dbId!)).toBeDefined();
  });

  it("enrichSource repairs stale dbId to match registry path", () => {
    const registry = new DatabaseRegistryService("/tmp/papr-data", "/tmp/papr-apps");
    const dbPath = "/Users/me/Papr/data/databases/myapp/data.db";
    const canonicalId = dbIdFromPath(dbPath);

    registry.mergeFromRegistryFile(
      JSON.stringify({
        version: 1,
        databases: {
          [canonicalId]: {
            dbId: canonicalId,
            localPath: dbPath,
            tursoShortName: dbTursoDatabaseName(canonicalId),
            isolation: "shared",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const enriched = registry.enrichSource({
      id: "bad:main",
      type: "sqlite",
      dbId: "db-wrong000",
      alias: "main",
      dbPath,
      tables: [],
      linkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(enriched.dbId).toBe(canonicalId);
  });
});
