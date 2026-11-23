import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fetchMock = vi.fn();
const creds = vi.fn();
const registry = {
  getById: vi.fn(),
  register: vi.fn(async (r: unknown) => r),
  assignSyncMode: vi.fn(),
};
vi.mock("../../utils/cloudApiClient.js", () => ({ cloudApiFetch: (...a: unknown[]) => fetchMock(...a) }));
vi.mock("../cloudDirect/cloudDirectDb.js", () => ({ setCloudDirectCredentials: (m: unknown) => creds(m) }));
vi.mock("../DatabaseRegistryService.js", () => ({ getDatabaseRegistryService: () => registry }));

const { registerCatalogAppDatabases } = await import("./catalogAppDatabases.js");

describe("catalog app databases in a cloud run", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "papr-cloud-session-"));
    const dir = path.join(home, "apps", "app-1");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "data-sources.json"), JSON.stringify({ sources: [
      { id: "db-1f3c043a:chores", type: "sqlite", dbId: "db-1f3c043a", alias: "chores",
        dbPath: "/Users/x/Papr/orgs/o/namespaces/n/data/databases/chores/data.db", tables: [], linkedAt: "" },
    ] }));
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ tursoUrl: "libsql://x", authToken: "t" }) });
    creds.mockReset();
    registry.getById.mockReset().mockReturnValue(undefined);
    registry.register.mockClear();
  });
  afterEach(() => fs.rm(home, { recursive: true, force: true }));

  it("mints a token and registers the database as cloud-direct", async () => {
    await expect(registerCatalogAppDatabases(home, "app-1")).resolves.toEqual(["db-1f3c043a"]);
    expect(fetchMock).toHaveBeenCalledWith("/v1/cloud/databases/token", expect.objectContaining({
      body: { database: "d-1f3c043a", appId: "app-1" },
    }));
    expect(creds).toHaveBeenCalledTimes(1);
    expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({
      dbId: "db-1f3c043a", tursoShortName: "d-1f3c043a", syncMode: "cloud-direct",
    }));
  });

  it("published copies with an empty dbPath still connect", async () => {
    const f = path.join(home, "apps", "app-1", "data-sources.json");
    const ds = JSON.parse(await fs.readFile(f, "utf8"));
    ds.sources[0].dbPath = "";
    await fs.writeFile(f, JSON.stringify(ds));
    await expect(registerCatalogAppDatabases(home, "app-1")).resolves.toEqual(["db-1f3c043a"]);
    expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({
      localPath: path.join(home, "data", "databases", "db-1f3c043a", "data.db"),
    }));
  });

  it("a token failure doesn't break loading the app", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "no" });
    await expect(registerCatalogAppDatabases(home, "app-1")).resolves.toEqual([]);
    expect(registry.register).not.toHaveBeenCalled();
  });
});
