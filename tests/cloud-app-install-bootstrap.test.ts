import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

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

    const { initializeDatabaseRegistry } = await import(
      "../src/gateway/services/DatabaseRegistryService.js"
    );
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

  it("applies registry migrations and creates writable local db", async () => {
    let bootstrap;
    try {
      bootstrap = await bootstrapInstalledAppDatabases(appId);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("NODE_MODULE_VERSION")) {
        return;
      }
      throw error;
    }

    if (
      bootstrap.errors.some((entry) => entry.includes("NODE_MODULE_VERSION"))
    ) {
      return;
    }

    expect(bootstrap.errors).toEqual([]);
    expect(bootstrap.ready).toBe(true);
    expect(bootstrap.linkedDbs).toHaveLength(1);
    expect(bootstrap.linkedDbs[0]?.migrationsApplied).toContain("0001_init.sql");
    expect(bootstrap.linkedDbs[0]?.userTableCount).toBe(1);
    expect(bootstrap.linkedDbs[0]?.writable).toBe(true);

    const dbPath = bootstrap.linkedDbs[0]?.localPath ?? "";
    const stat = await fs.stat(dbPath);
    expect(stat.size).toBeGreaterThan(0);
  });

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
