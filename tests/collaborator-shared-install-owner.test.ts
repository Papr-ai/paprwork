/**
 * A teammate installing a team app on the publisher's shared data must stay a
 * collaborator: the install remaps publisher id -> copy id in every app file,
 * including linked-databases.json's schemaOwnerAppId, which used to make the
 * copy look like the schema owner and switch off the collaborator migration
 * guard (2026-10-07: a contributor's copy migrated the shared database).
 */
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home = "";
vi.mock("../src/core/utils/paprRoot.js", async (orig) => ({
  ...(await orig<object>()),
  getPaprAppsRoot: () => path.join(home, "apps"),
}));
vi.mock("../src/gateway/services/DatabaseRegistryService.js", async (orig) => {
  const { readFileSync } = await import("node:fs");
  return {
    ...(await orig<object>()),
    getDatabaseRegistryService: () => ({
      getById: (id: string) =>
        JSON.parse(readFileSync(path.join(home, "data", "databases.json"), "utf8")).databases[id],
    }),
  };
});

import { syncAppLinkedResourcesToTarget } from "../src/gateway/services/copyAppToNamespace.js";
import { applyIdRemapsToDirectory } from "../src/gateway/utils/applyIdRemaps.js";
import { isCollaboratorOnSharedDatabase } from "../src/gateway/services/sharedPrimaryTursoResolve.js";

const PUBLISHER = "a3ead08d-fab2-43b3-852b-87784afcc436";
const COPY = "d9bd29a4-bb59-464f-96ca-e7ffd7bf3ec4";
const DB = "db-f3115d59";
const record = (owner: string) => ({
  dbId: DB, localPath: "", tursoShortName: "d-f3115d59", label: "Customer Contacts",
  isolation: "shared", status: "active", syncMode: "replica", schemaOwnerAppId: owner,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
});
const write = async (p: string, v: unknown) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(v, null, 2));
};
const owner = async () =>
  JSON.parse(await fs.readFile(path.join(home, "data", "databases.json"), "utf8")).databases[DB]
    ?.schemaOwnerAppId;

describe("shared-data install keeps the publisher as schema owner", () => {
  let repo = "";
  beforeEach(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "collab-own-home-"));
    repo = mkdtempSync(path.join(os.tmpdir(), "collab-own-repo-"));
    // Per-app repo: no workspace data/databases.json, the app ships linked-databases.json.
    const appDir = path.join(home, "apps", COPY);
    await write(path.join(appDir, "data-sources.json"), {
      sources: [{ id: `${DB}:contacts`, type: "sqlite", dbId: DB, alias: "contacts", tables: [] }],
    });
    await write(path.join(appDir, "linked-databases.json"), { version: 1, databases: { [DB]: record(PUBLISHER) } });
    await write(path.join(appDir, "papr-cloud-lineage.json"), {
      schemaVersion: "1.2.0", lineageId: "lin", mode: "track", databasePolicy: "shared",
      source: { namespaceId: "ns", slug: "customer-contacts", userId: "pub", appId: PUBLISHER },
    });
    await write(path.join(home, "data", "jobs.json"), []);
    // Same step CloudAppInstallService runs right after createApp.
    await applyIdRemapsToDirectory(appDir, new Map([[PUBLISHER, COPY]]));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("the remap alone does rewrite the owner (the bug this guards against)", async () => {
    const linked = JSON.parse(await fs.readFile(path.join(home, "apps", COPY, "linked-databases.json"), "utf8"));
    expect(linked.databases[DB].schemaOwnerAppId).toBe(COPY);
  });

  it("install registry records the publisher, and the copy is a collaborator", async () => {
    await syncAppLinkedResourcesToTarget({
      appId: COPY, sourceAppId: PUBLISHER, sourcePaprHome: repo, targetPaprHome: home,
      installDbPolicy: "shared_primary",
    });
    expect(await owner()).toBe(PUBLISHER);
    expect(isCollaboratorOnSharedDatabase(DB)).toBe(true);
  });

  it("re-install over a registry that already has the copy as owner fixes it", async () => {
    await write(path.join(home, "data", "databases.json"), { version: 1, databases: { [DB]: record(COPY) } });
    await syncAppLinkedResourcesToTarget({
      appId: COPY, sourceAppId: PUBLISHER, sourcePaprHome: repo, targetPaprHome: home,
      installDbPolicy: "shared_primary",
    });
    expect(await owner()).toBe(PUBLISHER);
  });

  it("copies installed before the fix (registry owner = the copy) are still collaborators", async () => {
    await write(path.join(home, "data", "databases.json"), { version: 1, databases: { [DB]: record(COPY) } });
    expect(isCollaboratorOnSharedDatabase(DB)).toBe(true);
  });

  it("the publisher's own app (no shared lineage) still owns its schema", async () => {
    await fs.mkdir(path.join(home, "apps", PUBLISHER), { recursive: true });
    await write(path.join(home, "data", "databases.json"), { version: 1, databases: { [DB]: record(PUBLISHER) } });
    expect(isCollaboratorOnSharedDatabase(DB)).toBe(false);
  });
});
