/** Get updates: a migration for a database this copy doesn't link is skipped, not a failed write. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let root = "";
vi.mock("../../../src/core/utils/paprRoot.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPaprRoot: () => root,
  getPaprAppsRoot: () => path.join(root, "apps"),
}));

const APP = "dca047a9-e118-4798-b7ee-e346f474b4d9";
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-unlinked-"));
  const db = (slug: string) => path.join(root, "data", "databases", slug, "data.db");
  await fs.mkdir(path.join(root, "apps", APP), { recursive: true });
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "databases.json"), JSON.stringify({ databases: {
    "db-4f9d137f": { status: "active", localPath: db("team-data-680") },
    "db-9c092d2b": { status: "active", localPath: db("workpapers891-9c092d2b") },
  } }));
  await fs.writeFile(path.join(root, "apps", APP, "data-sources.json"), JSON.stringify({ sources: [
    { id: "db-4f9d137f:notes", dbId: "db-4f9d137f" }, { id: "db-9c092d2b:wp", dbId: "db-9c092d2b" },
  ] }));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("isUnlinkedDatabaseMigrationPath", () => {
  it("skips a database the copy doesn't link; keeps linked ones (exact and suffixed) and non-migrations", async () => {
    const { isUnlinkedDatabaseMigrationPath: f } = await import("../../../src/gateway/services/syncV3/syncPulledSchemaOwnerMigrations.js");
    expect(await f(APP, "databases/s5newdb/migrations/0001_20261124230000_init_s5new.sql", root)).toBe(true);
    expect(await f(APP, "databases/s5newdb/migrations/snapshot.json", root)).toBe(true);
    expect(await f(APP, "databases/team-data-680/migrations/0023_20261126040000_e2e_priority.sql", root)).toBe(false);
    expect(await f(APP, "databases/workpapers891/migrations/0002_x.sql", root)).toBe(false);
    expect(await f(APP, "index.html", root)).toBe(false);
  });

  it("no links readable: never skips (old behaviour)", async () => {
    await fs.rm(path.join(root, "apps", APP, "data-sources.json"));
    const { isUnlinkedDatabaseMigrationPath: f } = await import("../../../src/gateway/services/syncV3/syncPulledSchemaOwnerMigrations.js");
    expect(await f(APP, "databases/s5newdb/migrations/0001_a.sql", root)).toBe(false);
  });
});
