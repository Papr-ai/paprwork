/**
 * Bundles carry the app's registry databases (data/databases/{slug}) with
 * their migrations, and import registers + builds them.
 *
 * Before: export copied only the primary data.db (then scrubbed it) and import
 * skipped any database whose data file was missing — so every scrubbed bundle
 * arrived pointing at a dbId the new workspace had never heard of, and publish
 * failed with "data-sources references database … missing from databases.json".
 */
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

const DB_ID = "db-0a1b2c3d";
const tmpRoots: string[] = [];
const envBefore = {
  HOME: process.env.HOME,
  PAPR_HOME: process.env.PAPR_HOME,
  PAPR_USER_DATA: process.env.PAPR_USER_DATA,
  CLOUD_SYNC_ENABLED: process.env.CLOUD_SYNC_ENABLED,
};

afterEach(async () => {
  for (const root of tmpRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

async function openWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-bundle-db-"));
  tmpRoots.push(root);
  process.env.HOME = root;
  process.env.PAPR_HOME = path.join(root, "Papr");
  process.env.PAPR_USER_DATA = path.join(root, ".paprwork-v2");
  process.env.CLOUD_SYNC_ENABLED = "false"; // local-only: no Turso provisioning
  await fs.mkdir(process.env.PAPR_HOME, { recursive: true });
  vi.resetModules();
  const { AppService } = await import("../../src/gateway/services/AppService.js");
  const { JobsService } = await import("../../src/gateway/services/JobsService.js");
  const { BundleService } = await import("../../src/gateway/services/BundleService.js");
  const registryMod = await import("../../src/gateway/services/DatabaseRegistryService.js");
  registryMod.resetDatabaseRegistryForWorkspaceSwitch();
  const appService = new AppService();
  const jobsService = new JobsService();
  await appService.initialize();
  await jobsService.initialize();
  const bundleService = new BundleService(appService, jobsService);
  await bundleService.initialize();
  const registry = await registryMod.initializeDatabaseRegistry();
  return { root, paprHome: process.env.PAPR_HOME, appService, bundleService, registry };
}

describe("bundle registry databases", () => {
  test("scrubbed bundle still registers the database and builds its tables", async () => {
    const src = await openWorkspace();
    const dbDir = path.join(src.paprHome, "data", "databases", "pen-run");
    await fs.mkdir(path.join(dbDir, "migrations"), { recursive: true });
    await fs.writeFile(
      path.join(dbDir, "migrations", "0001_init.sql"),
      "CREATE TABLE scores (id INTEGER PRIMARY KEY, points INTEGER NOT NULL);",
    );
    const dbPath = path.join(dbDir, "data.db");
    new Database(dbPath).close();
    await src.registry.register({ dbId: DB_ID, localPath: dbPath, label: "Pen Run", syncMode: null });
    const app = await src.appService.createApp("Pen Run", "game", [
      { filename: "index.html", content: "<h1>run</h1>" },
      {
        filename: "data-sources.json",
        content: JSON.stringify({
          sources: [{ id: `${DB_ID}:penrun`, type: "sqlite", dbId: DB_ID, alias: "penrun", dbPath, tables: [] }],
        }),
      },
    ]);

    const { manifest } = await src.bundleService.exportBundle({
      appId: app.id, bundleId: "pen-run", name: "Pen Run", version: "1.0.0", jobIds: [],
    });
    const bundlePath = path.join(src.paprHome, "bundles", "pen-run");
    expect(manifest.registryDatabases).toEqual([
      expect.objectContaining({ dbId: DB_ID, slug: "pen-run", migrationsPath: `databases/${DB_ID}/migrations` }),
    ]);
    expect(existsSync(path.join(bundlePath, "databases", DB_ID, "data.db"))).toBe(false); // scrubbed
    expect(existsSync(path.join(bundlePath, "databases", DB_ID, "migrations", "0001_init.sql"))).toBe(true);

    const dst = await openWorkspace();
    const result = await dst.bundleService.importBundle({ sourcePath: bundlePath });

    const record = dst.registry.getById(DB_ID);
    expect(record?.localPath).toBe(path.join(dst.paprHome, "data", "databases", "pen-run", "data.db"));
    expect(result.setupResults, JSON.stringify(result.setupResults)).toEqual([expect.objectContaining({ ok: true })]);
    const db = new Database(record!.localPath, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    db.close();
    expect(tables.map((t) => t.name)).toContain("scores");
  }, 30_000);
});
