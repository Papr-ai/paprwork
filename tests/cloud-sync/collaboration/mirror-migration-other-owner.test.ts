/** Audit D: a second copy of the same app pulls a migration another local app owns. */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { mirrorSchemaMigrationToRegistry } from "../../../src/gateway/services/syncV3/syncPulledSchemaOwnerMigrations.js";

const roots: string[] = [];
async function home(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-mirror-"));
  roots.push(root);
  const db = path.join(root, "data", "databases", "workpapers", "data.db");
  await fs.mkdir(path.join(path.dirname(db), "migrations"), { recursive: true });
  await fs.writeFile(
    path.join(root, "data", "databases.json"),
    JSON.stringify({ databases: { "db-1": { status: "active", schemaOwnerAppId: "owner-app", localPath: db } } }),
  );
  await fs.writeFile(path.join(path.dirname(db), "migrations", "0002_init.sql"), "CREATE TABLE w (id INTEGER);\n");
  return root;
}
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

describe("mirror a migration owned by another app on this machine", () => {
  it("identical file already there: unchanged (not a failed write)", async () => {
    const paprRoot = await home();
    const out = await mirrorSchemaMigrationToRegistry({
      appId: "second-copy",
      repoPath: "databases/workpapers/migrations/0002_init.sql",
      content: "CREATE TABLE w (id INTEGER);\n",
      paprRoot,
    });
    expect(out).toEqual({ kind: "unchanged" });
  });

  it("different or missing file: still refused", async () => {
    const paprRoot = await home();
    const differs = await mirrorSchemaMigrationToRegistry({
      appId: "second-copy",
      repoPath: "databases/workpapers/migrations/0002_init.sql",
      content: "CREATE TABLE w (id TEXT);\n",
      paprRoot,
    });
    expect(differs).toEqual({ kind: "skipped", reason: "not schema owner for slug" });
    const missing = await mirrorSchemaMigrationToRegistry({
      appId: "second-copy",
      repoPath: "databases/workpapers/migrations/0003_more.sql",
      content: "ALTER TABLE w ADD COLUMN x TEXT;\n",
      paprRoot,
    });
    expect(missing).toEqual({ kind: "skipped", reason: "not schema owner for slug" });
  });
});
