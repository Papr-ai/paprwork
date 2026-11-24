/** A database a teammate adds to a team app is their draft, not team data (workpapers891). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const records = new Map<string, Record<string, unknown>>();
let appsRoot = "";
vi.mock("../../../src/core/utils/paprRoot.js", () => ({
  getPaprAppsRoot: () => appsRoot,
  getPaprRoot: () => path.dirname(appsRoot),
}));
vi.mock("../../../src/gateway/services/DatabaseRegistryService.js", () => ({
  getDatabaseRegistryService: () => ({ getById: (id: string) => records.get(id) }),
  tursoNameForRecord: (r: { dbId: string }) => r.dbId.replace("db-", "d-"),
}));

const {
  isCollaboratorOnSharedDatabase,
  resolveSharedPrimaryTursoEntry,
  resolveTeamCopyPublisherUserId,
  dbIdsInDataSources,
} = await import("../../../src/gateway/services/sharedPrimaryTursoResolve.js");

const COPY = "dca047a9-e118-4798-b7ee-e346f474b4d9";
function copy(lineageExtra: Record<string, unknown>) {
  const dir = path.join(appsRoot, COPY);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "metadata.json"), "{}");
  fs.writeFileSync(
    path.join(dir, "data-sources.json"),
    JSON.stringify({ sources: [
      { id: "a", type: "sqlite", dbId: "db-4f9d137f", alias: "notes", dbPath: "/x" },
      { id: "b", type: "sqlite", dbId: "db-9c092d2b", alias: "workpapers891", dbPath: "/y" },
    ] }),
  );
  fs.writeFileSync(
    path.join(dir, "papr-cloud-lineage.json"),
    JSON.stringify({
      schemaVersion: "1.2.0", lineageId: "l", mode: "track", databasePolicy: "shared",
      installedAt: "2026-11-04T19:41:30.151Z",
      source: { orgId: "o", namespaceId: "n", userId: "publisher", appId: "pub", slug: "team-data-680" },
      ...lineageExtra,
    }),
  );
}

beforeEach(() => {
  appsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "draft-db-"));
  records.clear();
  records.set("db-4f9d137f", { dbId: "db-4f9d137f", isolation: "shared", schemaOwnerAppId: "e5ba032d", createdAt: "2026-11-04T23:24:02Z" });
  records.set("db-9c092d2b", { dbId: "db-9c092d2b", isolation: "shared", schemaOwnerAppId: COPY, createdAt: "2026-11-24T07:08:16Z" });
});
afterEach(() => fs.rmSync(appsRoot, { recursive: true, force: true }));

describe.each([
  ["teamDbIds recorded at install", { teamDbIds: ["db-4f9d137f"] }],
  ["older install (no teamDbIds): created after install by this copy", {}],
])("%s", (_name, extra) => {
  it("the publisher's database is team data", () => {
    copy(extra);
    expect(isCollaboratorOnSharedDatabase("db-4f9d137f")).toBe(true);
    expect(resolveSharedPrimaryTursoEntry("d-4f9d137f")?.publisherUserId).toBe("publisher");
    expect(resolveTeamCopyPublisherUserId("db-4f9d137f")).toBe("publisher");
  });
  it("the teammate's new database is their draft: own token, own migrations", () => {
    copy(extra);
    expect(isCollaboratorOnSharedDatabase("db-9c092d2b")).toBe(false);
    expect(resolveSharedPrimaryTursoEntry("d-9c092d2b")).toBeNull();
    expect(resolveTeamCopyPublisherUserId("db-9c092d2b")).toBeUndefined();
  });
});

it("after the proposal is accepted the pull records it as team data", () => {
  copy({ teamDbIds: ["db-4f9d137f", "db-9c092d2b"] });
  expect(isCollaboratorOnSharedDatabase("db-9c092d2b")).toBe(true);
});

it("reads dbIds from data-sources.json", () => {
  expect(dbIdsInDataSources(JSON.stringify({ sources: [{ dbId: "db-1" }, { alias: "x" }] }))).toEqual(["db-1"]);
  expect(dbIdsInDataSources(undefined)).toEqual([]);
});
