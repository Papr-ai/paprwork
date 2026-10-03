/**
 * Regression: publish froze the gateway 5.2s because buildCloudAppMeta opened a
 * replica-managed DB with better-sqlite3 on the main thread while the turso sync
 * worker held it (sqlite busy timeout). Replica files must be read via the worker.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replicaPaths = new Set<string>();
const workerRead = vi.fn(async () => ["0001_init", "0002_add_col"]);
const sqliteOpen = vi.fn();

vi.mock("../src/gateway/services/tursoReplica/tursoReplicaFileGuard.js", () => ({
  isReplicaManagedDbPath: (p: string) => replicaPaths.has(path.normalize(p)),
}));
vi.mock("../src/gateway/services/tursoReplica/tursoReplicaMigrationConflict.js", () => ({
  readLocalReplicaMigrationIds: workerRead,
}));
vi.mock("../src/gateway/services/databaseDiagnostics/sqlite.js", () => ({
  openDiagnosticDatabase: (...args: unknown[]) => {
    sqliteOpen(...args);
    return { close: () => undefined };
  },
}));
vi.mock("../src/gateway/services/jobs/schemaMigrationsLedger.js", () => ({
  listAppliedMigrationIdsReadOnly: () => ["0001_local"],
}));
let sources: Array<{ appId: string; dbPath: string; dbId?: string }> = [];
vi.mock("../src/gateway/services/tursoLinkedSources.js", () => ({
  discoverTursoLinkedSources: async () => sources,
}));
vi.mock("../src/gateway/services/DatabaseRegistryService.js", () => ({
  getDatabaseRegistryService: () => ({ listBySchemaOwnerApp: () => [] }),
}));

describe("buildCloudAppMeta replica reads", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-"));
    replicaPaths.clear();
    workerRead.mockClear();
    sqliteOpen.mockClear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads replica-managed DBs through the sync worker, never better-sqlite3", async () => {
    const dbPath = path.join(dir, "notes", "data.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");
    replicaPaths.add(path.normalize(dbPath));
    sources = [{ appId: "app-1", dbPath, dbId: "db-1" }];

    const { buildCloudAppMeta } = await import("../src/gateway/services/cloudSync/cloudAppMeta.js");
    const meta = await buildCloudAppMeta(dir, "app-1", dir);

    expect(sqliteOpen).not.toHaveBeenCalled();
    expect(workerRead).toHaveBeenCalledWith(expect.objectContaining({ dbPath, dbId: "db-1" }));
    expect(meta.requiredSchemaVersion).toBe("0002_add_col");
  });

  it("opens non-replica local files with a short busy timeout", async () => {
    const dbPath = path.join(dir, "local.db");
    fs.writeFileSync(dbPath, "");
    sources = [{ appId: "app-1", dbPath }];

    const { buildCloudAppMeta } = await import("../src/gateway/services/cloudSync/cloudAppMeta.js");
    await buildCloudAppMeta(dir, "app-1", dir);

    expect(workerRead).not.toHaveBeenCalled();
    const opts = sqliteOpen.mock.calls[0]?.[3] as { timeout?: number; readonly?: boolean };
    expect(opts.readonly).toBe(true);
    expect(opts.timeout).toBeLessThanOrEqual(250);
  });
});
