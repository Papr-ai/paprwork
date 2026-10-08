import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LinkedIn Outreach, 2026-10-05..07: Connection Sender, Graph Harvester and
// Search Scraper failed every scheduled run in <1s with "Plan A replica DB at
// Jobs/{id}/data/data.db must use @tursodatabase/sync — writable better-sqlite3
// open is blocked". Those job files were cut over to the sync engine by an older
// build. ensureDatabase/withDatabase already stood down on such a file;
// applyMigrations did not, and runSingleAttempt awaits it before the job starts.
const managed = new Set<string>();
vi.mock("../src/gateway/services/tursoReplica/tursoReplicaFileGuard.js", () => ({
  isReplicaManagedDbPath: (p: string) => managed.has(path.normalize(p)),
}));
const applyDatabaseMigrations = vi.fn(async () => ["0002_x.sql"]);
vi.mock("../src/gateway/services/jobs/databaseMigrations.js", () => ({
  applyDatabaseMigrations: (...a: unknown[]) => applyDatabaseMigrations(...(a as [])),
  applySqlitePerformancePragmas: () => {},
}));

let root = "";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "jobdb-standdown-"));
  managed.clear();
  applyDatabaseMigrations.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function jobDir(): string {
  const dir = path.join(root, "Jobs", "32be089d-83d5-4e03-a71c-25b588c961f8");
  mkdirSync(path.join(dir, "data"), { recursive: true });
  writeFileSync(path.join(dir, "data", "data.db"), "");
  return dir;
}

describe("JobDatabase on a job file the sync engine owns", () => {
  it("applyMigrations stands down instead of opening it writable", async () => {
    const { JobDatabase } = await import("../src/gateway/services/jobs/JobDatabase.js");
    const dir = jobDir();
    managed.add(path.normalize(path.join(dir, "data", "data.db")));
    await expect(new JobDatabase().applyMigrations(dir)).resolves.toEqual([]);
    expect(applyDatabaseMigrations).not.toHaveBeenCalled();
  });

  it("still applies migrations on an ordinary job scratch file", async () => {
    const { JobDatabase } = await import("../src/gateway/services/jobs/JobDatabase.js");
    await expect(new JobDatabase().applyMigrations(jobDir())).resolves.toEqual(["0002_x.sql"]);
    expect(applyDatabaseMigrations).toHaveBeenCalledTimes(1);
  });
});
