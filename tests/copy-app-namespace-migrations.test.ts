import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

vi.mock("../src/gateway/services/TursoSyncBridge.js", () => ({
  ensureTursoSyncBridge: vi.fn(() => ({
    pullAppLinkedSources: vi.fn(async () => ({
      attempted: 0,
      pushed: 0,
      pulled: 0,
      skipped: 0,
      failed: 0,
      results: [],
    })),
  })),
  syncTursoAfterAppInstall: vi.fn(async () => ({
    attempted: 0,
    pushed: 0,
    pulled: 0,
    skipped: 0,
    failed: 0,
    results: [],
  })),
}));

import {
  finalizeCopiedAppResources,
  syncAppLinkedResourcesToTarget,
} from "../src/gateway/services/copyAppToNamespace.js";
import { bootstrapCopiedAppDatabasesInWorkspace } from "../src/gateway/services/cloudAppInstallBootstrap.js";

describe("copy / fork database bootstrap", () => {
  let targetHome: string;
  let sourceHome: string;
  let localAppId: string;
  const publisherDbId = "db-7c4c3837";

  beforeEach(async () => {
    localAppId = randomUUID();
    sourceHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-copy-src-"));
    targetHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-copy-tgt-"));

    await fs.mkdir(path.join(targetHome, "apps", localAppId), {
      recursive: true,
    });
    await fs.mkdir(path.join(targetHome, "data"), { recursive: true });
    await fs.mkdir(
      path.join(sourceHome, "data", "databases", "gtm-prep-guide"),
      { recursive: true },
    );

    await fs.mkdir(
      path.join(sourceHome, "data", "databases", "gtm-prep-guide", "migrations"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(
        sourceHome,
        "data",
        "databases",
        "gtm-prep-guide",
        "migrations",
        "0001_engagement.sql",
      ),
      `CREATE TABLE IF NOT EXISTS engagement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);`,
      "utf8",
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
              "data/databases/gtm-prep-guide/data.db",
            ),
            tursoShortName: "d-7c4c3837",
            label: "GTM Prep Guide",
            isolation: "shared",
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
              id: `${publisherDbId}:prep`,
              type: "sqlite",
              dbId: publisherDbId,
              alias: "prep",
              dbPath: "",
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

  it.skipIf(!canUseBetterSqlite)(
    "fork_empty sync then workspace bootstrap creates app tables",
    async () => {
      const sync = await syncAppLinkedResourcesToTarget({
        appId: localAppId,
        sourcePaprHome: sourceHome,
        targetPaprHome: targetHome,
        installDbPolicy: "fork_empty",
      });

      expect(sync.registryDbIds.length).toBe(1);
      const newDbId = sync.registryDbIds[0]!;

      const bootstrap = await bootstrapCopiedAppDatabasesInWorkspace(
        localAppId,
        targetHome,
      );

      expect(bootstrap.errors).toEqual([]);
      expect(bootstrap.linkedDbs[0]?.migrationsApplied).toContain(
        "0001_engagement.sql",
      );

      const dbPath = bootstrap.linkedDbs[0]?.localPath ?? "";
      expect(dbPath.length).toBeGreaterThan(0);

      const db = new Database(dbPath, { readonly: true });
      try {
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='engagement'",
          )
          .all() as Array<{ name: string }>;
        expect(tables).toHaveLength(1);

        const applied = db
          .prepare("SELECT id FROM schema_migrations ORDER BY id")
          .all() as Array<{ id: string }>;
        expect(applied.map((row) => row.id)).toContain("0001_engagement.sql");
      } finally {
        db.close();
      }

      const registryRaw = await fs.readFile(
        path.join(targetHome, "data", "databases.json"),
        "utf8",
      );
      const registry = JSON.parse(registryRaw) as {
        databases: Record<string, { dbId: string }>;
      };
      expect(registry.databases[newDbId]).toBeDefined();
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "finalizeCopiedAppResources applies migrations after org-style copy",
    async () => {
      const slugDir = path.join(targetHome, "data", "databases", "gtm-prep-guide");
      await fs.mkdir(path.join(slugDir, "migrations"), { recursive: true });
      await fs.cp(
        path.join(
          sourceHome,
          "data",
          "databases",
          "gtm-prep-guide",
          "migrations",
          "0001_engagement.sql",
        ),
        path.join(slugDir, "migrations", "0001_engagement.sql"),
      );

      const dbPath = path.join(slugDir, "data.db");
      await fs.writeFile(
        path.join(targetHome, "data", "databases.json"),
        JSON.stringify({
          version: 1,
          databases: {
            [publisherDbId]: {
              dbId: publisherDbId,
              localPath: dbPath,
              tursoShortName: "d-7c4c3837",
              label: "GTM Prep Guide",
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
      );

      await finalizeCopiedAppResources({
        targetPaprHome: targetHome,
        appId: localAppId,
        copiedJobIds: [],
        registryDbIds: [publisherDbId],
      });

      const db = new Database(dbPath, { readonly: true });
      try {
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='engagement'",
          )
          .all() as Array<{ name: string }>;
        expect(tables).toHaveLength(1);
      } finally {
        db.close();
      }
    },
  );
});
