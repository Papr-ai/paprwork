import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let appsRoot = "";
const records: Record<string, Record<string, unknown>> = {};

vi.mock("../src/core/utils/paprRoot.js", async (orig) => ({
  ...(await orig<object>()),
  getPaprAppsRoot: () => appsRoot,
}));
vi.mock("../src/gateway/services/DatabaseRegistryService.js", async (orig) => ({
  ...(await orig<object>()),
  getDatabaseRegistryService: () => ({ getById: (id: string) => records[id] }),
}));

import { isCollaboratorOnSharedDatabase } from "../src/gateway/services/sharedPrimaryTursoResolve.js";

function installApp(appId: string, dbId: string, lineage?: object): void {
  const dir = path.join(appsRoot, appId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "data-sources.json"),
    JSON.stringify({ sources: [{ id: `${dbId}:x`, type: "sqlite", dbId, alias: "x" }] }),
  );
  if (lineage) {
    writeFileSync(path.join(dir, "papr-cloud-lineage.json"), JSON.stringify(lineage));
  }
}

const trackLineage = {
  schemaVersion: "1.2.0",
  lineageId: "lin-1",
  mode: "track",
  databasePolicy: "shared",
  source: { namespaceId: "ns", slug: "enrichment", userId: "pub" },
};

describe("collaborators never migrate a team-shared database", () => {
  beforeEach(() => {
    appsRoot = mkdtempSync(path.join(tmpdir(), "collab-db-"));
    for (const k of Object.keys(records)) delete records[k];
  });
  afterEach(() => rmSync(appsRoot, { recursive: true, force: true }));

  it("collaborator install of a shared db: skip migrations", () => {
    records["db-1"] = { dbId: "db-1", isolation: "shared", schemaOwnerAppId: "publisher-app" };
    installApp("my-install", "db-1", trackLineage);
    expect(isCollaboratorOnSharedDatabase("db-1")).toBe(true);
  });

  it("publisher (owner app on this desktop): migrate", () => {
    records["db-1"] = { dbId: "db-1", isolation: "shared", schemaOwnerAppId: "publisher-app" };
    installApp("publisher-app", "db-1");
    expect(isCollaboratorOnSharedDatabase("db-1")).toBe(false);
  });

  it("fork on its own data: migrate", () => {
    records["db-2"] = { dbId: "db-2", isolation: "shared", schemaOwnerAppId: "my-fork" };
    installApp("my-fork", "db-2", { ...trackLineage, mode: "fork", databasePolicy: "forked" });
    expect(isCollaboratorOnSharedDatabase("db-2")).toBe(false);
  });
});
