/**
 * Two-user collaboration repro for Get updates (audit bugs 1, 2, 5).
 *
 * User A publishes (writer repo HEAD moves). User B's desktop pulls.
 * Network pieces are mocked; OID cache, commit cursors, file merge and
 * registry-migration mirroring run for real against a temp workspace.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const SLUG = "collab-db";

const state = {
  remoteDir: "",
  remoteFiles: {} as Record<string, string>,
  commitSha: "sha-1",
  needsFlush: false,
};

const migrationsApplied: string[] = [];

vi.mock("../src/gateway/services/syncV3/AppOpsClient.js", async () => {
  const { computeBlobOidForContent } = await import(
    "../src/gateway/services/syncV3/computeParentHash.js"
  );
  return {
    fetchAppRepoHead: vi.fn(async () => ({
      commitSha: state.commitSha,
      files: await Promise.all(
        Object.entries(state.remoteFiles).map(async ([p, c]) => ({
          path: p,
          blobOid: await computeBlobOidForContent(c),
        })),
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
    for (const [rel, content] of Object.entries(state.remoteFiles)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content);
    }
    return { sourceDir: dir, cleanup: async () => fs.rm(dir, { recursive: true, force: true }) };
  }),
}));

vi.mock("../src/gateway/services/cloudSync/pendingLocalUploads.js", () => ({
  appNeedsOrderedFlushAsync: vi.fn(async () => state.needsFlush),
}));

vi.mock("../src/gateway/services/cloudSync/cloudSyncSingleton.js", () => ({
  getCloudSyncService: () => ({
    ensureFreshToken: async () => "tok",
    markRelativePathSynced: () => {},
  }),
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

vi.mock("../src/gateway/services/DatabaseRegistryService.js", async () => {
  const { getPaprRoot } = await import("../src/core/utils/paprRoot.js");
  return {
    getDatabaseRegistryService: () => ({
      listBySchemaOwnerApp: (appId: string) =>
        appId === APP_ID
          ? [{ dbId: "db-1", localPath: path.join(getPaprRoot(), "data", "databases", SLUG, "data.db"), schemaOwnerAppId: APP_ID, status: "active" }]
          : [],
    }),
    registrySlugFromLocalPath: (p: string) =>
      p.replace(/\\/g, "/").match(/\/data\/databases\/([^/]+)\/data\.db$/)?.[1] ?? null,
  };
});

vi.mock("../src/gateway/services/jobs/databaseMigrations.js", () => ({
  applyRegistryDatabaseMigrations: vi.fn(async () => {
    migrationsApplied.push("apply-called");
    return [];
  }),
}));

vi.mock("../src/gateway/websocket/index.js", () => ({ broadcast: vi.fn() }));
vi.mock("../src/gateway/services/TursoSyncBridge.js", () => ({ getTursoSyncBridge: () => null }));
vi.mock("../src/gateway/services/tursoSyncSession.js", () => ({ reconcileLinkedSourcesFromCloud: vi.fn() }));
vi.mock("../src/gateway/services/CloudAppPublishService.js", () => ({
  getCloudAppPublishService: () => ({ getCloudPublishStatus: async () => ({ published: false }) }),
}));

import { getPaprAppsRoot, getPaprRoot } from "../src/core/utils/paprRoot.js";
import { pullAppCodeFromRepo } from "../src/gateway/services/syncV3/pullAppCodeFromRepo.js";
import { pullAppFromCloud } from "../src/gateway/services/syncV3/pullAppFromCloud.js";

const appFile = (rel: string) => path.join(getPaprAppsRoot(), APP_ID, rel);
const regMigration = (name: string) => path.join(getPaprRoot(), "data", "databases", SLUG, "migrations", name);
const read = (p: string) => fs.readFile(p, "utf8").catch(() => null);

/** Both users start synced at sha-1 with the same code. */
async function seedSyncedBaseline(): Promise<void> {
  state.commitSha = "sha-1";
  state.needsFlush = false;
  state.remoteFiles = {
    "index.html": "<div id=app></div>",
    "app.ts": "render(v1)",
    "styles.css": "a{}",
  };
  // B has never pulled before — first pull writes files and acks OIDs.
  await pullAppCodeFromRepo(APP_ID, { token: "t", allowRecentSkip: false });
}

beforeEach(async () => {
  migrationsApplied.length = 0;
  process.env.PAPR_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "collab-home-"));
  await seedSyncedBaseline();
});

afterEach(() => {
  delete process.env.PAPR_HOME;
});

describe("Bug 1 (fixed) — conflicts hold the whole update", () => {
  async function setupConflict(): Promise<void> {
    await fs.writeFile(appFile("app.ts"), "render(v1) // B tweak");
    state.commitSha = "sha-2";
    state.remoteFiles = {
      ...state.remoteFiles,
      "index.html": "<div id=app data-col=notes></div>",
      "app.ts": "render(v2 uses notes column)",
      [`databases/${SLUG}/migrations/0002_add_notes.sql`]: "ALTER TABLE t ADD COLUMN notes TEXT;",
    };
  }

  it("hold (default): nothing is written — no code, no migration", async () => {
    await setupConflict();
    const res = await pullAppFromCloud(APP_ID, { token: "t", allowRecentSkip: false, preferCloudOverLocal: true });

    expect(res.code.conflictFiles).toEqual(["app.ts"]);
    expect(res.code.heldForConflicts).toBe(true);
    expect(await read(appFile("index.html"))).toBe("<div id=app></div>");
    expect(await read(appFile("app.ts"))).toContain("B tweak");
    expect(await read(regMigration("0002_add_notes.sql"))).toBeNull();
    expect(migrationsApplied).toEqual([]);
  });

  it("take theirs: whole update applied, including migrations", async () => {
    await setupConflict();
    const res = await pullAppFromCloud(APP_ID, {
      token: "t", allowRecentSkip: false, preferCloudOverLocal: true, resolution: "take_theirs",
    });

    expect(res.code.conflictFiles).toEqual([]);
    expect(await read(appFile("index.html"))).toContain("data-col=notes");
    expect(await read(appFile("app.ts"))).toBe("render(v2 uses notes column)");
    expect(await read(regMigration("0002_add_notes.sql"))).toContain("notes");
    expect(migrationsApplied).toEqual(["apply-called"]);
  });

  it("keep mine: my file kept, everything else + migrations applied", async () => {
    await setupConflict();
    const res = await pullAppFromCloud(APP_ID, {
      token: "t", allowRecentSkip: false, preferCloudOverLocal: true, resolution: "keep_mine",
    });

    expect(res.code.keptLocalFiles).toEqual(["app.ts"]);
    expect(await read(appFile("index.html"))).toContain("data-col=notes");
    expect(await read(appFile("app.ts"))).toContain("B tweak");
    expect(await read(regMigration("0002_add_notes.sql"))).toContain("notes");
    expect(migrationsApplied).toEqual(["apply-called"]);
  });
});

describe("Bug 2 (fixed) — deferred auto-update stays visible and is not lost", () => {
  it("does not advance the commit cursor when the desktop pull is deferred", async () => {
    const { applyRemoteCommit } = await import(
      "../src/gateway/services/syncV3/appRepoRevisionSubscriber.js"
    );
    const { getPendingAppUpdate, resetPendingAppUpdatesForTests } = await import(
      "../src/gateway/services/syncV3/appRepoPendingUpdate.js"
    );
    resetPendingAppUpdatesForTests();

    // B has an unpushed row (pendingOps > 0) → ordered flush needed.
    state.needsFlush = true;
    state.commitSha = "sha-2";
    state.remoteFiles = { ...state.remoteFiles, "app.ts": "render(v2)" };

    const applied = await applyRemoteCommit(APP_ID, "sha-2");
    expect(applied).toBe(false);
    expect(await read(appFile("app.ts"))).toBe("render(v1)");
    // Visible "update waiting" state instead of a console-only skip.
    expect(getPendingAppUpdate(APP_ID)).toMatchObject({
      commitSha: "sha-2",
      reason: "local changes pending upload",
    });

    // Rows get pushed; flush flag clears. Get updates now actually pulls.
    state.needsFlush = false;
    const manual = await pullAppFromCloud(APP_ID, { token: "t", allowRecentSkip: false });

    expect(manual.code.skipped).toBeFalsy();
    expect(await read(appFile("app.ts"))).toBe("render(v2)");
    expect(getPendingAppUpdate(APP_ID)).toBeNull();
    resetPendingAppUpdatesForTests();
  });

  it("auto-retry applies the waiting update once local rows are pushed", async () => {
    const { applyRemoteCommit } = await import(
      "../src/gateway/services/syncV3/appRepoRevisionSubscriber.js"
    );
    const { getPendingAppUpdate, resetPendingAppUpdatesForTests } = await import(
      "../src/gateway/services/syncV3/appRepoPendingUpdate.js"
    );
    resetPendingAppUpdatesForTests();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      state.needsFlush = true;
      state.commitSha = "sha-2";
      state.remoteFiles = { ...state.remoteFiles, "app.ts": "render(v2)" };
      await applyRemoteCommit(APP_ID, "sha-2");
      expect(getPendingAppUpdate(APP_ID)).not.toBeNull();

      state.needsFlush = false;
      await vi.advanceTimersByTimeAsync(31_000);
      vi.useRealTimers();
      await vi.waitFor(async () => {
        expect(await read(appFile("app.ts"))).toBe("render(v2)");
      });
      expect(getPendingAppUpdate(APP_ID)).toBeNull();
    } finally {
      vi.useRealTimers();
      resetPendingAppUpdatesForTests();
    }
  });
});

describe("Bug 5 — migration filename collision", () => {
  it("B's same-named local migration silently shadows A's different SQL", async () => {
    // B's agent wrote 0002_add_notes.sql locally (not published).
    await fs.mkdir(path.dirname(regMigration("x")), { recursive: true });
    await fs.writeFile(regMigration("0002_add_notes.sql"), "ALTER TABLE t ADD COLUMN notes INTEGER;");

    // A published a different 0002_add_notes.sql.
    state.commitSha = "sha-2";
    state.remoteFiles = {
      ...state.remoteFiles,
      [`databases/${SLUG}/migrations/0002_add_notes.sql`]: "ALTER TABLE t ADD COLUMN notes TEXT; CREATE INDEX i ON t(notes);",
    };

    const res = await pullAppCodeFromRepo(APP_ID, { token: "t", allowRecentSkip: false });

    // Not reported as a conflict — just skipped.
    expect(res.conflictFiles).toEqual([]);
    expect(res.skippedFiles).toContain(`databases/${SLUG}/migrations/0002_add_notes.sql`);
    expect(await read(regMigration("0002_add_notes.sql"))).toContain("INTEGER");
  });
});
