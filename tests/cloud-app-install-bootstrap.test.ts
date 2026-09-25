import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "fs";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

// Vendored better-sqlite3 is built for Electron's ABI; skip under plain vitest when it won't load.
let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

const syncTursoAfterAppInstall = vi.fn(async () => ({
  attempted: 0,
  pushed: 0,
  pulled: 0,
  skipped: 0,
  failed: 0,
  results: [],
}));

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
  syncTursoAfterAppInstall: (...args: unknown[]) =>
    syncTursoAfterAppInstall(...args),
}));

import {
  bootstrapInstalledAppDatabases,
  buildCloudInstallAgentSetupMessage,
} from "../src/gateway/services/cloudAppInstallBootstrap.js";

describe("cloud app install bootstrap", () => {
  let paprHome: string;
  let appId: string;
  let dbId: string;
  let originalPaprHome: string | undefined;
  let originalGatewayMode: string | undefined;

  beforeEach(async () => {
    syncTursoAfterAppInstall.mockClear();
    syncTursoAfterAppInstall.mockResolvedValue({
      attempted: 0,
      pushed: 0,
      pulled: 0,
      skipped: 0,
      failed: 0,
      results: [],
    });
    appId = randomUUID();
    dbId = "db-2d6b4294";
    paprHome = await fs.mkdtemp(path.join(os.tmpdir(), "papr-bootstrap-"));
    originalPaprHome = process.env.PAPR_HOME;
    originalGatewayMode = process.env.GATEWAY_MODE;
    process.env.PAPR_HOME = paprHome;
    process.env.GATEWAY_MODE = "cloud_agent";

    const slug = "gtm-foundations";
    const slugDir = path.join(paprHome, "data", "databases", slug);
    await fs.mkdir(path.join(slugDir, "migrations"), { recursive: true });
    await fs.writeFile(
      path.join(slugDir, "migrations", "0001_init.sql"),
      `CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL
);`,
      "utf8",
    );

    await fs.mkdir(path.join(paprHome, "apps", appId), { recursive: true });
    await fs.writeFile(
      path.join(paprHome, "apps", appId, "data-sources.json"),
      JSON.stringify(
        {
          sources: [
            {
              id: `${dbId}:gtm`,
              type: "sqlite",
              dbId,
              alias: "gtm",
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

    await fs.mkdir(path.join(paprHome, "data"), { recursive: true });
    await fs.writeFile(
      path.join(paprHome, "data", "databases.json"),
      JSON.stringify(
        {
          version: 1,
          databases: {
            [dbId]: {
              dbId,
              localPath: path.join(slugDir, "data.db"),
              tursoShortName: "d-2d6b4294",
              label: "GTM Foundations",
              isolation: "shared",
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      ),
    );

    const {
      initializeDatabaseRegistry,
      resetDatabaseRegistryForWorkspaceSwitch,
    } = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
    resetDatabaseRegistryForWorkspaceSwitch();
    await initializeDatabaseRegistry();
  });

  afterEach(async () => {
    if (originalPaprHome === undefined) {
      delete process.env.PAPR_HOME;
    } else {
      process.env.PAPR_HOME = originalPaprHome;
    }
    if (originalGatewayMode === undefined) {
      delete process.env.GATEWAY_MODE;
    } else {
      process.env.GATEWAY_MODE = originalGatewayMode;
    }
    await fs.rm(paprHome, { recursive: true, force: true });
  });

  it.skipIf(!canUseBetterSqlite)(
    "applies registry migrations and creates writable local db",
    async () => {
      const bootstrap = await bootstrapInstalledAppDatabases(appId);

      expect(syncTursoAfterAppInstall).toHaveBeenCalledTimes(1);
      expect(bootstrap.errors).toEqual([]);
      expect(bootstrap.ready).toBe(true);
      expect(bootstrap.linkedDbs).toHaveLength(1);
      expect(bootstrap.linkedDbs[0]?.migrationsApplied).toContain("0001_init.sql");
      expect(bootstrap.linkedDbs[0]?.userTableCount).toBe(1);
      expect(bootstrap.linkedDbs[0]?.writable).toBe(true);

      const dbPath = bootstrap.linkedDbs[0]?.localPath ?? "";
      const stat = await fs.stat(dbPath);
      expect(stat.size).toBeGreaterThan(0);
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "applies git migrations before Turso pull",
    async () => {
      const slugDir = path.join(paprHome, "data", "databases", "gtm-foundations");
      syncTursoAfterAppInstall.mockImplementation(async () => {
        const dbPath = path.join(slugDir, "data.db");
        expect(existsSync(dbPath)).toBe(true);
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare(
            "SELECT 1 AS ok FROM schema_migrations WHERE id = '0001_init.sql' LIMIT 1",
          )
          .get() as { ok: number } | undefined;
        db.close();
        expect(row?.ok).toBe(1);
        return {
          attempted: 0,
          pushed: 0,
          pulled: 0,
          skipped: 0,
          failed: 0,
          results: [],
        };
      });

      await bootstrapInstalledAppDatabases(appId);
      expect(syncTursoAfterAppInstall).toHaveBeenCalledTimes(1);
    },
  );

  it.skipIf(!canUseBetterSqlite)(
    "fork_empty skips Turso sync and applies local schema only",
    async () => {
      const bootstrap = await bootstrapInstalledAppDatabases(appId, {
        installDbPolicy: "fork_empty",
        deferTursoUntilPublish: true,
      });

      expect(syncTursoAfterAppInstall).not.toHaveBeenCalled();
      expect(bootstrap.errors).toEqual([]);
      expect(bootstrap.ready).toBe(true);
      expect(bootstrap.linkedDbs[0]?.tursoPull).toBe("skipped");
      expect(bootstrap.linkedDbs[0]?.migrationsApplied).toContain("0001_init.sql");
      expect(bootstrap.warnings.some((w) => w.includes("Turso pull skipped"))).toBe(
        false,
      );
    },
  );

  it("builds agent setup message with bootstrap details", () => {
    const message = buildCloudInstallAgentSetupMessage({
      appTitle: "GTM Foundations",
      appId,
      sourceSlug: "gtm-foundations-audit",
      bootstrap: {
        appId,
        linkedDbs: [],
        ready: false,
        needsSeed: true,
        errors: ["Could not resolve local path"],
        warnings: ["Turso pull skipped"],
      },
    });

    expect(message).toContain("GTM Foundations");
    expect(message).toContain(appId);
    expect(message).toContain("Could not resolve local path");
    expect(message).toContain("migrations");
  });
});
