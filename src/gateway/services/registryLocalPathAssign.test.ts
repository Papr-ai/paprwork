import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignMissingLocalPaths } from "./registryLocalPathAssign.js";
import { DatabaseRegistryService } from "./DatabaseRegistryService.js";

let root = "";
let dataDir = "";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "reg-path-"));
  dataDir = path.join(root, "data");
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const rec = (dbId: string, localPath: string, label?: string, status = "active") => ({
  dbId, localPath, status, ...(label ? { label } : {}),
});
const dbFile = (slug: string) => path.join(dataDir, "databases", slug, "data.db");

describe("assignMissingLocalPaths", () => {
  it("gives a blank active record the standard path from its label", () => {
    const dbs = { "db-4f9d137f": rec("db-4f9d137f", "", "Team Data 680") };
    expect(assignMissingLocalPaths(dbs, dataDir)).toEqual(["db-4f9d137f"]);
    expect(dbs["db-4f9d137f"].localPath).toBe(dbFile("team-data-680"));
  });

  it("never touches a record that already has a path, or an inactive one", () => {
    const dbs = {
      a: rec("db-a", "/somewhere/else/data.db", "A"),
      b: rec("db-b", "", "B", "tombstone"),
    };
    expect(assignMissingLocalPaths(dbs, dataDir)).toEqual([]);
    expect(dbs.a.localPath).toBe("/somewhere/else/data.db");
    expect(dbs.b.localPath).toBe("");
  });

  it("does not reuse a folder another record owns", () => {
    const dbs = {
      owner: rec("db-11111111", dbFile("notes"), "Notes"),
      fresh: rec("db-22222222", "", "Notes"),
    };
    assignMissingLocalPaths(dbs, dataDir);
    expect(dbs.fresh.localPath).toBe(dbFile("notes-22222222"));
  });

  it("does not adopt an unknown file already on disk", () => {
    mkdirSync(path.dirname(dbFile("notes")), { recursive: true });
    writeFileSync(dbFile("notes"), "leftover");
    const dbs = { fresh: rec("db-33333333", "", "Notes") };
    assignMissingLocalPaths(dbs, dataDir);
    expect(dbs.fresh.localPath).toBe(dbFile("notes-33333333"));
  });

  it("two blank records with the same label get different folders", () => {
    const dbs = { x: rec("db-aaaaaaaa", "", "Same"), y: rec("db-bbbbbbbb", "", "Same") };
    assignMissingLocalPaths(dbs, dataDir);
    expect(dbs.x.localPath).not.toBe(dbs.y.localPath);
  });

  it("falls back to the dbId when there is no label", () => {
    const dbs = { x: rec("db-0a7e5c31", "") };
    assignMissingLocalPaths(dbs, dataDir);
    expect(dbs.x.localPath).toBe(dbFile("db-0a7e5c31"));
  });

  it("does nothing where there is no local data folder (cloud host)", () => {
    const dbs = { x: rec("db-1", "", "X") };
    expect(assignMissingLocalPaths(dbs, path.join(root, "missing"))).toEqual([]);
    expect(dbs.x.localPath).toBe("");
  });
});

describe("DatabaseRegistryService", () => {
  it("repairs blank paths on load and persists them", async () => {
    writeFileSync(
      path.join(dataDir, "databases.json"),
      JSON.stringify({
        version: 1,
        databases: {
          "db-4f9d137f": {
            dbId: "db-4f9d137f", localPath: "", tursoShortName: "d-4f9d137f",
            label: "Team Data 680", isolation: "shared", status: "active", syncMode: "replica",
            createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z",
          },
        },
      }),
    );
    const registry = new DatabaseRegistryService(dataDir, path.join(root, "apps"));
    await registry.initialize();
    expect(registry.getById("db-4f9d137f")?.localPath).toBe(dbFile("team-data-680"));
    await new Promise((r) => setTimeout(r, 50));
    const saved = JSON.parse(readFileSync(path.join(dataDir, "databases.json"), "utf8"));
    expect(saved.databases["db-4f9d137f"].localPath).toBe(dbFile("team-data-680"));
  });

  it("assigns a path to a record adopted from a cloud registry file", async () => {
    const registry = new DatabaseRegistryService(dataDir, path.join(root, "apps"));
    await registry.initialize();
    registry.mergeFromRegistryFile(JSON.stringify({
      version: 1,
      databases: {
        "db-9c092d2b": {
          dbId: "db-9c092d2b", localPath: "", tursoShortName: "d-9c092d2b",
          label: "workpapers891", isolation: "shared", status: "active", syncMode: "replica",
        },
      },
    }));
    expect(registry.getById("db-9c092d2b")?.localPath).toBe(dbFile("workpapers891"));
  });
});
