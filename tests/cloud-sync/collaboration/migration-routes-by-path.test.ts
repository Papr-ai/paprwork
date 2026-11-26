/** A migration belongs to the database named in its path, or to none (stuck hold on workpapers891). */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

import {
  hydrateAppFolderSchemaMigrationsToRegistry,
  registrySlugForRepoSlug,
} from "../../../src/gateway/services/syncV3/syncPulledSchemaOwnerMigrations.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

describe("registrySlugForRepoSlug", () => {
  const owned = (...slugs: string[]) => new Map(slugs.map((s) => [s, `/x/${s}/data.db`]));
  it("same name", () => expect(registrySlugForRepoSlug(owned("notes"), "notes")).toBe("notes"));
  it("install-time id suffix", () =>
    expect(registrySlugForRepoSlug(owned("notes-59e5ad02"), "notes")).toBe("notes-59e5ad02"));
  it("never another database, even when the app owns just one", () =>
    expect(registrySlugForRepoSlug(owned("workpapers891"), "team-data-680")).toBe("team-data-680"));
  it("ambiguous suffixes: no guess", () =>
    expect(registrySlugForRepoSlug(owned("notes-aaaaaaaa", "notes-bbbbbbbb"), "notes")).toBe("notes"));
});

describe("hydrate from the app folder", () => {
  it("an app that owns one database doesn't copy another database's migrations into it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-route-"));
    roots.push(root);
    const appId = "dca047a9-e118-4798-b7ee-e346f474b4d9";
    const own = path.join(root, "data", "databases", "workpapers891");
    await fs.mkdir(path.join(own, "migrations"), { recursive: true });
    await fs.writeFile(
      path.join(root, "data", "databases.json"),
      JSON.stringify({ databases: { "db-9c092d2b": { status: "active", schemaOwnerAppId: appId, localPath: path.join(own, "data.db") } } }),
    );
    const other = path.join(root, "apps", appId, "databases", "team-data-680", "migrations");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "0002_create_notes.sql"), "CREATE TABLE notes (id INTEGER);\n");

    const out = await hydrateAppFolderSchemaMigrationsToRegistry({ appId, paprRoot: root, appsRoot: path.join(root, "apps") });
    expect(out.copied).toEqual([]);
    expect(await fs.readdir(path.join(own, "migrations"))).toEqual([]);
  });
});
