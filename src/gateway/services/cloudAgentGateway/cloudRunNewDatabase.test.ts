import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";

const mintMock = vi.fn();
const notifyMock = vi.fn();
vi.mock("./catalogAppDatabases.js", () => ({ mintToken: (...a: unknown[]) => mintMock(...a) }));
vi.mock("./cloudAppWriterDebouncedPush.js", () => ({
  notifyCloudSandboxAppSave: (id: string) => notifyMock(id),
}));

describe("new database inside a cloud agent run", () => {
  let base: string;
  let home: string;
  let primaryFile: string;
  const saved = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    base = await fs.mkdtemp(path.join(os.tmpdir(), "cloudrun-newdb-"));
    home = path.join(base, "papr-cloud-session", "imessage-x", "Papr");
    await fs.mkdir(path.join(home, "data"), { recursive: true });
    // Sandbox only — HOME moves too so no active-workspace pointer can win.
    process.env.HOME = base;
    process.env.PAPR_HOME = home;
    process.env.GATEWAY_MODE = "cloud_agent";
    process.env.CLOUD_SYNC_ENABLED = "false";
    primaryFile = path.join(base, "primary.db");
    mintMock.mockReset().mockResolvedValue({ url: `file:${primaryFile}`, authToken: "t" });
    notifyMock.mockReset();
  });
  afterEach(async () => {
    process.env = { ...saved };
    await fs.rm(base, { recursive: true, force: true });
  });

  it("lives in the cloud: tables and rows reach the primary; schema ships with the app", async () => {
    const { getPaprRoot } = await import("../../../core/utils/paprRoot.js");
    expect(getPaprRoot()).toBe(home);

    const { createDatabaseTool } = await import("../../../core/tools/databases.js");
    const created = (await (createDatabaseTool.execute as any)({ name: "Family Chores" })).data;
    expect(created.syncMode).toBe("cloud-direct");
    expect(mintMock).toHaveBeenCalledWith(created.tursoShortName);
    await expect(fs.stat(created.localPath)).rejects.toThrow();

    const { paprDbCreateMigration, paprDbExec } = await import("../tursoReplica/PaprDbService.js");
    await paprDbCreateMigration({
      dbId: created.dbId,
      name: "init",
      sql: "CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT);",
    });
    await paprDbExec({ dbId: created.dbId, sql: "INSERT INTO members (name) VALUES ('Amir')" });

    const primary = createClient({ url: `file:${primaryFile}` });
    const rows = await primary.execute("SELECT name FROM members");
    expect(rows.rows.map((r) => r.name)).toEqual(["Amir"]);
    primary.close();

    // Once an app owns the schema, a new migration queues that app's publish
    // and the files are part of what it sends.
    const { initializeDatabaseRegistry } = await import("../DatabaseRegistryService.js");
    const reg = await initializeDatabaseRegistry();
    await fs.mkdir(path.join(home, "apps", "app-1"), { recursive: true });
    await fs.writeFile(path.join(home, "apps", "app-1", "index.html"), "<p/>");
    await reg.ensureForPath(created.localPath, { schemaOwnerAppId: "app-1" });
    await paprDbCreateMigration({
      dbId: created.dbId,
      name: "add_role",
      sql: "ALTER TABLE members ADD COLUMN role TEXT;",
    });
    expect(notifyMock).toHaveBeenCalledWith("app-1");

    const { collectAppOpFiles } = await import("../syncV3/collectAppOpFiles.js");
    const files = (await collectAppOpFiles(home, "app-1")).files.map((f) => f.path);
    const schemaFiles = files.filter((f) => f.startsWith("databases/family-chores/"));
    // 0001_baseline (platform starter) + the two created above.
    expect(schemaFiles).toHaveLength(3);
  });

  it("desktop is unchanged", async () => {
    delete process.env.GATEWAY_MODE;
    const { isCloudAgentRunSandbox } = await import("./cloudRunNewDatabase.js");
    expect(isCloudAgentRunSandbox()).toBe(false);
  });
});
