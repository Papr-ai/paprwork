import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addFile = vi.fn(async (_db: unknown, args: { appId: string; filePath: string }) => ({
  id: "file-1",
  objectKey: `apps/${args.appId}/x`,
  sha256: "0".repeat(64),
  sizeBytes: 3,
  deduped: false,
  verified: true,
}));
const ensureSchema = vi.fn(async () => undefined);
const cloudDirectQuery = vi.fn(async () => ({ rows: [], columns: [], count: 0 }));
const cloudDirectWrite = vi.fn(async () => ({ changes: 1 }));

vi.mock("../appFiles/AppFilesService.js", async (orig) => ({
  ...(await orig<typeof import("../appFiles/AppFilesService.js")>()),
  addFile,
  ensureSchema,
}));
vi.mock("../cloudDirect/cloudDirectDb.js", () => ({
  cloudDirectQuery,
  cloudDirectWrite,
  isCloudDirectSource: () => true,
}));

let root: string;
const APP = "app-files-test";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sandbox-files-"));
  process.env.PAPR_HOME = root;
  await mkdir(path.join(root, "apps", APP), { recursive: true });
  await writeFile(
    path.join(root, "apps", APP, "data-sources.json"),
    JSON.stringify({ sources: [{ id: "db-1:story", type: "sqlite", dbId: "db-1", alias: "story", dbPath: "" }] }),
  );
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function post(route: string, body: unknown) {
  const { createSandboxLocalApi } = await import("./sandboxLocalApi.js");
  const server = createSandboxLocalApi().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe("sandbox local API: App Files", () => {
  it("registers a job's file through the app's cloud database (papr_files.add)", async () => {
    const file = path.join(root, "film.mp4");
    await writeFile(file, "abc");
    const res = await post("/api/files/upload", { appId: APP, filePath: file, fileName: "film.mp4" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("file-1");
    expect(addFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: APP, filePath: file, fileName: "film.mp4", keepLocal: true }),
    );
  });

  it("writes the file row with the cloud-direct client, not a local file", async () => {
    addFile.mockImplementationOnce(async (db: unknown) => {
      await (db as { run: (s: string, p: unknown[]) => Promise<unknown> }).run("INSERT INTO app_files (id) VALUES (?)", ["f"]);
      return { id: "f", objectKey: "k", sha256: "s", sizeBytes: 1, deduped: false, verified: true };
    });
    const file = path.join(root, "a.mp3");
    await writeFile(file, "x");
    const res = await post("/api/files/upload", { appId: APP, filePath: file });
    expect(res.status).toBe(200);
    expect(cloudDirectWrite).toHaveBeenCalledWith(
      expect.objectContaining({ dbId: "db-1", alias: "story" }),
      "INSERT INTO app_files (id) VALUES (?)",
      ["f"],
    );
  });

  it("rejects an upload without appId and filePath", async () => {
    const res = await post("/api/files/upload", { appId: APP });
    expect(res.status).toBe(400);
  });
});
