/**
 * Get updates merges like git: files both sides edited in different places
 * combine on their own; only overlapping lines ask Mine / Theirs, per file.
 * dryRun reports all of it for the status panel without writing anything.
 *
 * The clone mock is a real git repo holding every blob ever published, so the
 * base version (last synced blob) can be read the same way production does.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const APP_ID = "22222222-3333-4444-5555-666666666666";
const state = { remoteFiles: {} as Record<string, string>, commitSha: "sha-1", published: [] as string[] };

vi.mock("../src/gateway/services/syncV3/AppOpsClient.js", async () => {
  const { computeBlobOidForContent } = await import("../src/gateway/services/syncV3/computeParentHash.js");
  return {
    fetchAppRepoHead: vi.fn(async () => ({
      commitSha: state.commitSha,
      files: await Promise.all(
        Object.entries(state.remoteFiles).map(async ([p, c]) => ({ path: p, blobOid: await computeBlobOidForContent(c) })),
      ),
    })),
  };
});
vi.mock("../src/gateway/services/syncV3/AppRepoClient.js", () => ({
  getAppRepoRecord: vi.fn(async () => ({ cloneUrl: "x", appId: APP_ID })),
  ensureAppRepoRecord: vi.fn(async () => ({ cloneUrl: "x", appId: APP_ID })),
  fetchAppRepoReadCredentials: vi.fn(async () => ({ token: "t", cloneUrl: "x", repoPath: "" })),
}));
vi.mock("../src/gateway/services/cloudSync/cloudGitClone.js", () => ({
  isGitRepositoryNotFoundError: () => false,
  cloneCloudAppSource: vi.fn(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-"));
    execFileSync("git", ["init", "-q", dir]);
    // Every version ever published is in the object store, like the real repo.
    for (const content of state.published) {
      execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: content });
    }
    for (const [rel, content] of Object.entries(state.remoteFiles)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content);
    }
    return { sourceDir: dir, repoDir: dir, cleanup: async () => fs.rm(dir, { recursive: true, force: true }) };
  }),
}));
vi.mock("../src/gateway/services/cloudSync/pendingLocalUploads.js", () => ({ appNeedsOrderedFlushAsync: vi.fn(async () => false) }));
vi.mock("../src/gateway/services/cloudSync/cloudSyncSingleton.js", () => ({
  getCloudSyncService: () => ({ ensureFreshToken: async () => "tok", markRelativePathSynced: () => {}, clearManualFlushError: () => {} }),
}));
vi.mock("../src/gateway/services/AppService.js", async () => {
  const { getPaprAppsRoot } = await import("../src/core/utils/paprRoot.js");
  return {
    getAppService: () => ({
      getApp: async () => null,
      updateApp: async () => {},
      writeAppFile: async (appId: string, rel: string, content: string) => {
        const full = path.join(getPaprAppsRoot(), appId, rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content);
        return true;
      },
    }),
  };
});
vi.mock("../src/gateway/services/DatabaseRegistryService.js", () => ({
  getDatabaseRegistryService: () => ({ listBySchemaOwnerApp: () => [] }),
  registrySlugFromLocalPath: () => null,
}));
vi.mock("../src/gateway/services/jobs/databaseMigrations.js", () => ({ applyRegistryDatabaseMigrations: vi.fn(async () => []) }));
vi.mock("../src/gateway/websocket/index.js", () => ({ broadcast: vi.fn() }));
vi.mock("../src/gateway/services/TursoSyncBridge.js", () => ({ getTursoSyncBridge: () => null }));
vi.mock("../src/gateway/services/tursoSyncSession.js", () => ({ reconcileLinkedSourcesFromCloud: vi.fn() }));

import { getPaprAppsRoot } from "../src/core/utils/paprRoot.js";
import { pullAppCodeFromRepo } from "../src/gateway/services/syncV3/pullAppCodeFromRepo.js";
import { pullAppFromCloud } from "../src/gateway/services/syncV3/pullAppFromCloud.js";

const appFile = (rel: string) => path.join(getPaprAppsRoot(), APP_ID, rel);
const read = (rel: string) => fs.readFile(appFile(rel), "utf8");
const lines = (...l: string[]) => `${l.join("\n")}\n`;

function publish(files: Record<string, string>, sha: string): void {
  state.remoteFiles = files;
  state.commitSha = sha;
  state.published.push(...Object.values(files));
}

const BASE_APP = lines("function load() {", "  return 1;", "}", "", "function draw() {", "  return 'a';", "}");
const BASE_CHART = lines("const title = 'Sales';", "", "const axis = 'x';");

beforeEach(async () => {
  process.env.PAPR_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "merge-home-"));
  state.published = [];
  publish({ "app.ts": BASE_APP, "chart.ts": BASE_CHART, "index.html": "<div></div>" }, "sha-1");
  await pullAppCodeFromRepo(APP_ID, { token: "t", allowRecentSkip: false });
});

/** Mine: edits load() in app.ts and the title in chart.ts.
 *  Theirs: edits draw() in app.ts (no overlap) and the title in chart.ts (overlap), adds legacy.ts. */
async function divergeBothSides(): Promise<void> {
  await fs.writeFile(appFile("app.ts"), BASE_APP.replace("return 1;", "return 2; // mine"));
  await fs.writeFile(appFile("chart.ts"), BASE_CHART.replace("'Sales'", "'Revenue'"));
  publish({
    "app.ts": BASE_APP.replace("return 'a';", "return 'b'; // theirs"),
    "chart.ts": BASE_CHART.replace("'Sales'", "'Bookings'"),
    "index.html": "<div></div>",
    "new.ts": "export const added = true;\n",
  }, "sha-2");
}

describe("Get updates merges non-overlapping edits", () => {
  it("dryRun: reports merged, overlapping and new files; writes nothing", async () => {
    await divergeBothSides();
    const res = await pullAppFromCloud(APP_ID, { token: "t", allowRecentSkip: false, preferCloudOverLocal: true, dryRun: true });

    expect(res.code.mergedFiles).toEqual(["app.ts"]);
    expect(res.code.conflictFiles).toEqual(["chart.ts"]);
    expect(res.code.incoming).toEqual(
      expect.arrayContaining([
        { path: "app.ts", change: "edited", merged: true },
        { path: "chart.ts", change: "edited", conflict: true },
        { path: "new.ts", change: "added" },
      ]),
    );
    expect(await read("app.ts")).toContain("// mine");
    expect(await read("app.ts")).not.toContain("// theirs");
    await expect(read("new.ts")).rejects.toThrow();
  });

  it("hold: an overlap still holds the whole update (merge included)", async () => {
    await divergeBothSides();
    const res = await pullAppFromCloud(APP_ID, { token: "t", allowRecentSkip: false, preferCloudOverLocal: true });

    expect(res.code.heldForConflicts).toBe(true);
    expect(res.code.conflictFiles).toEqual(["chart.ts"]);
    expect(await read("app.ts")).not.toContain("// theirs");
    await expect(read("new.ts")).rejects.toThrow();
  });

  it("per-file Mine: overlap keeps mine, the clean merge and new files land together", async () => {
    await divergeBothSides();
    const res = await pullAppFromCloud(APP_ID, {
      token: "t", allowRecentSkip: false, preferCloudOverLocal: true, fileResolutions: { "chart.ts": "mine" },
    });

    expect(res.code.heldForConflicts).toBeFalsy();
    expect(res.code.mergedFiles).toEqual(["app.ts"]);
    expect(res.code.keptLocalFiles).toEqual(["chart.ts"]);
    const app = await read("app.ts");
    expect(app).toContain("// mine");
    expect(app).toContain("// theirs");
    expect(await read("chart.ts")).toContain("Revenue");
    expect(await read("new.ts")).toContain("added");
  });

  it("per-file Theirs: overlap takes the publisher's version", async () => {
    await divergeBothSides();
    await pullAppFromCloud(APP_ID, {
      token: "t", allowRecentSkip: false, preferCloudOverLocal: true, fileResolutions: { "chart.ts": "theirs" },
    });

    expect(await read("chart.ts")).toContain("Bookings");
    expect(await read("app.ts")).toContain("// mine");
  });

  it("no overlap at all: applies straight away with no question", async () => {
    await fs.writeFile(appFile("app.ts"), BASE_APP.replace("return 1;", "return 2; // mine"));
    publish({ ...state.remoteFiles, "app.ts": BASE_APP.replace("return 'a';", "return 'b'; // theirs") }, "sha-2");
    const res = await pullAppFromCloud(APP_ID, { token: "t", allowRecentSkip: false, preferCloudOverLocal: true });

    expect(res.code.heldForConflicts).toBeFalsy();
    expect(res.code.conflictFiles).toEqual([]);
    expect(res.code.mergedFiles).toEqual(["app.ts"]);
    expect(await read("app.ts")).toMatch(/mine[\s\S]*theirs/);
  });
});
