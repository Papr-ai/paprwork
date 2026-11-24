import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseRegistryService } from "../../src/gateway/services/DatabaseRegistryService.js";

const linked = (dbId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    databases: {
      [dbId]: { dbId, tursoShortName: dbId.replace("db-", "d-"), label: "Workpapers", isolation: "shared", status: "active", syncMode: "replica", localPath: "", ...extra },
    },
  });

describe("adoptLinkedDatabasesFile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function freshRegistry(databases: Record<string, unknown> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-adopt-"));
    dirs.push(root);
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "databases.json"), JSON.stringify({ version: 1, databases }));
    return { svc: new DatabaseRegistryService(dataDir, path.join(root, "apps")), file: path.join(dataDir, "databases.json") };
  }

  it("persists a database a pulled app links but this workspace has never seen", async () => {
    const { svc, file } = freshRegistry();
    const adopted = await svc.adoptLinkedDatabasesFile(linked("db-707ef4c1"));
    expect(adopted).toEqual(["db-707ef4c1"]);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.databases["db-707ef4c1"]).toMatchObject({ tursoShortName: "d-707ef4c1", status: "active" });
  });

  it("leaves records this workspace already has untouched", async () => {
    const existing = { dbId: "db-0bf61538", localPath: "/x/data.db", tursoShortName: "d-0bf61538", label: "Mine", isolation: "shared", status: "active", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const { svc, file } = freshRegistry({ "db-0bf61538": existing });
    expect(await svc.adoptLinkedDatabasesFile(linked("db-0bf61538", { label: "Theirs" }))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).databases["db-0bf61538"].label).toBe("Mine");
  });

  it("ignores tombstones and junk", async () => {
    const { svc } = freshRegistry();
    expect(await svc.adoptLinkedDatabasesFile(linked("db-11112222", { status: "tombstone" }))).toEqual([]);
    expect(await svc.adoptLinkedDatabasesFile("not json")).toEqual([]);
  });
});
