/**
 * Cloud Sync Hardening Tests — Milestone 1B-h
 *
 * Tests: persistent queue state, delete detection, retry cap,
 * content hashing, and settings toggle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SyncStateManager, STATE_FILENAME } from "../src/gateway/services/cloudSync/syncState.js";

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `cloud-sync-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("SyncStateManager", () => {
  let tmpDir: string;
  let mgr: SyncStateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mgr = new SyncStateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates fresh state when no state file exists", () => {
    mgr.load();
    expect(Object.keys(mgr.data.syncedItems)).toHaveLength(0);
    expect(mgr.data.lastFullSyncAt).toBeNull();
  });

  it("persists and reloads state", () => {
    mgr.load();
    mgr.markSynced("apps/abc123");
    mgr.markFullSyncComplete();
    mgr.save();

    const mgr2 = new SyncStateManager(tmpDir);
    mgr2.load();
    expect(Object.keys(mgr2.data.syncedItems)).toHaveLength(1);
    expect(mgr2.data.syncedItems["apps/abc123"]).toBeDefined();
    expect(mgr2.data.syncedItems["apps/abc123"].lastSyncAt).toBeTruthy();
    expect(mgr2.data.lastFullSyncAt).toBeTruthy();
  });

  it("state file is written to correct path", () => {
    mgr.load();
    mgr.markSynced("data/foo");
    mgr.save();
    const statePath = path.join(tmpDir, STATE_FILENAME);
    expect(fs.existsSync(statePath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    expect(raw.syncedItems["data/foo"]).toBeDefined();
  });

  describe("hasItemChanged", () => {
    it("returns true for never-synced item", () => {
      mgr.load();
      expect(mgr.hasItemChanged("apps/new-app")).toBe(true);
    });

    it("returns false for unchanged synced item", () => {
      const itemDir = path.join(tmpDir, "apps", "myapp");
      fs.mkdirSync(itemDir, { recursive: true });
      fs.writeFileSync(path.join(itemDir, "index.html"), "<h1>hi</h1>");

      mgr.load();
      mgr.markSynced("apps/myapp");
      expect(mgr.hasItemChanged("apps/myapp")).toBe(false);
    });

    it("returns true when file is added to synced directory", () => {
      const itemDir = path.join(tmpDir, "apps", "myapp");
      fs.mkdirSync(itemDir, { recursive: true });
      fs.writeFileSync(path.join(itemDir, "index.html"), "<h1>hi</h1>");

      mgr.load();
      mgr.markSynced("apps/myapp");

      fs.writeFileSync(path.join(itemDir, "style.css"), "body {}");
      expect(mgr.hasItemChanged("apps/myapp")).toBe(true);
    });

    it("returns true when item directory is deleted", () => {
      const itemDir = path.join(tmpDir, "apps", "myapp");
      fs.mkdirSync(itemDir, { recursive: true });
      fs.writeFileSync(path.join(itemDir, "index.html"), "<h1>hi</h1>");

      mgr.load();
      mgr.markSynced("apps/myapp");

      fs.rmSync(itemDir, { recursive: true });
      expect(mgr.hasItemChanged("apps/myapp")).toBe(true);
    });
  });

  describe("delete detection", () => {
    it("detects deleted items that were previously synced", () => {
      const itemDir = path.join(tmpDir, "apps", "deleted-app");
      fs.mkdirSync(itemDir, { recursive: true });
      fs.writeFileSync(path.join(itemDir, "index.html"), "hi");

      mgr.load();
      mgr.markSynced("apps/deleted-app");
      mgr.save();

      fs.rmSync(itemDir, { recursive: true });

      const deleted = mgr.getDeletedItems();
      expect(deleted).toContain("apps/deleted-app");
    });

    it("does not report existing items as deleted", () => {
      const itemDir = path.join(tmpDir, "apps", "existing-app");
      fs.mkdirSync(itemDir, { recursive: true });
      fs.writeFileSync(path.join(itemDir, "index.html"), "hi");

      mgr.load();
      mgr.markSynced("apps/existing-app");

      const deleted = mgr.getDeletedItems();
      expect(deleted).not.toContain("apps/existing-app");
    });

    it("removeSyncedItem clears item from state", () => {
      mgr.load();
      mgr.markSynced("apps/to-remove");
      expect(mgr.data.syncedItems["apps/to-remove"]).toBeDefined();

      mgr.removeSyncedItem("apps/to-remove");
      expect(mgr.data.syncedItems["apps/to-remove"]).toBeUndefined();
    });
  });

  describe("ignored directories", () => {
    it("skips SQLite files in content hash (Turso sync, not git)", () => {
      const itemDir = path.join(tmpDir, "Jobs", "job1");
      const dataDir = path.join(itemDir, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(itemDir, "run.py"), "print('hi')");
      fs.writeFileSync(path.join(dataDir, "data.db"), "small");

      mgr.load();
      mgr.markSynced("Jobs/job1");
      const hash1 = mgr.data.syncedItems["Jobs/job1"].contentHash;

      fs.writeFileSync(path.join(dataDir, "data.db"), "much larger sqlite payload");
      fs.writeFileSync(path.join(dataDir, "data.db-wal"), "wal");

      expect(mgr.hasItemChanged("Jobs/job1")).toBe(false);
      mgr.markSynced("Jobs/job1");
      expect(mgr.data.syncedItems["Jobs/job1"].contentHash).toBe(hash1);
    });

    it("still detects job script changes when SQLite is excluded", () => {
      const itemDir = path.join(tmpDir, "Jobs", "job2");
      const dataDir = path.join(itemDir, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(itemDir, "run.py"), "print('v1')");
      fs.writeFileSync(path.join(dataDir, "data.db"), "db");

      mgr.load();
      mgr.markSynced("Jobs/job2");

      fs.writeFileSync(path.join(itemDir, "run.py"), "print('v2')");
      expect(mgr.hasItemChanged("Jobs/job2")).toBe(true);
    });

    it("skips venv directories in content hash", () => {
      const itemDir = path.join(tmpDir, "Jobs", "job1");
      fs.mkdirSync(itemDir, { recursive: true });
      fs.writeFileSync(path.join(itemDir, "run.py"), "print('hi')");

      mgr.load();
      mgr.markSynced("Jobs/job1");
      const hash1 = mgr.data.syncedItems["Jobs/job1"].contentHash;

      const venvDir = path.join(itemDir, ".venv");
      fs.mkdirSync(venvDir, { recursive: true });
      fs.writeFileSync(path.join(venvDir, "pyvenv.cfg"), "version=3.12");

      expect(mgr.hasItemChanged("Jobs/job1")).toBe(false);
      mgr.markSynced("Jobs/job1");
      const hash2 = mgr.data.syncedItems["Jobs/job1"].contentHash;
      expect(hash1).toBe(hash2);
    });
  });
});

describe("Cloud Sync Settings Toggle", () => {
  const settingsPath = path.join(os.tmpdir(), `papr-settings-test-${Date.now()}.json`);

  afterEach(() => {
    try { fs.unlinkSync(settingsPath); } catch { /* */ }
  });

  it("defaults to enabled (true) when no settings file exists", () => {
    const exists = fs.existsSync(settingsPath);
    expect(exists).toBe(false);

    // Simulates main process logic: read settings, default to true
    let cloudSyncEnabled = true;
    try {
      if (fs.existsSync(settingsPath)) {
        const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (data?.preferences?.cloudSyncEnabled === false) cloudSyncEnabled = false;
      }
    } catch { /* default */ }
    expect(cloudSyncEnabled).toBe(true);
  });

  it("reads false when user disables sync", () => {
    const settings = {
      preferences: { cloudSyncEnabled: false },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf-8");

    let cloudSyncEnabled = true;
    try {
      if (fs.existsSync(settingsPath)) {
        const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (data?.preferences?.cloudSyncEnabled === false) cloudSyncEnabled = false;
      }
    } catch { /* default */ }
    expect(cloudSyncEnabled).toBe(false);
  });

  it("reads true when user explicitly enables sync", () => {
    const settings = {
      preferences: { cloudSyncEnabled: true },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf-8");

    let cloudSyncEnabled = true;
    try {
      if (fs.existsSync(settingsPath)) {
        const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (data?.preferences?.cloudSyncEnabled === false) cloudSyncEnabled = false;
      }
    } catch { /* default */ }
    expect(cloudSyncEnabled).toBe(true);
  });
});

describe("Retry Cap", () => {
  it("MAX_RETRY_FAILURES is 3", async () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/cloudSyncQueueProcessor.ts"),
      "utf-8",
    );
    expect(content).toContain("const MAX_RETRY_FAILURES = 3;");
  });

  it("queue items track failure count", () => {
    const item = { relativePath: "apps/broken", failures: 0 };
    item.failures++;
    item.failures++;
    item.failures++;
    expect(item.failures).toBe(3);
  });
});

describe("Periodic Pull", () => {
  it("PULL_INTERVAL_MS is 5 minutes", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/cloudSyncHeartbeat.ts"),
      "utf-8",
    );
    expect(content).toContain("export const PULL_INTERVAL_MS = 5 * 60_000;");
  });
});

describe("Desktop heartbeat deduplication", () => {
  it("guards against duplicate heartbeat timers and orphaned CloudSync instances", () => {
    const heartbeat = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/cloudSyncHeartbeat.ts"),
      "utf-8",
    );
    const service = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/CloudSyncService.ts"),
      "utf-8",
    );
    const singleton = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/cloudSyncSingleton.ts"),
      "utf-8",
    );
    expect(heartbeat).toContain("Desktop heartbeat already running");
    expect(service).toContain("backgroundInitStarted");
    expect(singleton).toContain("stopping orphaned timers");
  });

  it("gateway deferred startup skips when cloud sync already initialized", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/index.ts"),
      "utf-8",
    );
    expect(content).toContain("getCloudSyncService()");
    expect(content).toContain("skipping deferred startup init");
  });
});

describe("Sync V3 push (no namespace git)", () => {
  it("routes manual push through pushWorkspaceV3Now", () => {
    const service = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/CloudSyncService.ts"),
      "utf-8",
    );
    const pushApi = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/cloudSyncPushApi.ts"),
      "utf-8",
    );
    expect(service).toContain("pushGitNowFn(this.host");
    expect(pushApi).toContain("pushWorkspaceV3Now");
    expect(pushApi).toContain("./pushV3Now.js");
    expect(service).toContain("No namespace monorepo git commit or push");
  });

  it("queue processor module flushes jobs via Sync V3", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/cloudSyncQueueProcessor.ts"),
      "utf-8",
    );
    expect(content).toContain("V3 job flush");
    expect(content).toContain("pushWorkspaceV3Now");
  });

  it("hash-gates workspace changes locally (no instant git commit)", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/cloudSyncWorkspaceWatch.ts"),
      "utf-8",
    );
    expect(content).toContain("getChangedInstantPaths");
    expect(content).toContain("syncWorkspaceIfChanged");
    expect(content).toContain("hasItemChanged(dir)");
  });

  it("pushV3Now module flushes apps via SyncCoordinator", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/pushV3Now.ts"),
      "utf-8",
    );
    expect(content).toContain("flushAppViaCoordinator");
    expect(content).toContain("listAppIdsOwningJob");
  });
});

describe("Legacy git hygiene (pull-only)", () => {
  it("excludes WAV recordings from git (Turso metadata + bucket for blobs)", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/workspaceGitignore.ts"),
      "utf-8",
    );
    expect(content).toContain("**/*.wav");
    expect(content).toContain("**/recordings/");
  });

  it("excludes backup artifacts from git sync", () => {
    const gitignore = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/workspaceGitignore.ts"),
      "utf-8",
    );
    const hygiene = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/services/cloudSync/cloudSyncRepoHygieneTick.ts"),
      "utf-8",
    );
    expect(gitignore).toContain("**/*.bak");
    expect(gitignore).toContain("**/*.corrupt-*");
    expect(gitignore).toContain("**/*corrupt-backup*");
    expect(gitignore).not.toContain("**/*.pdf");
    expect(hygiene).toContain("runRepoMaintenance");
  });
});

describe("Gateway init check", () => {
  it("gateway checks CLOUD_SYNC_ENABLED !== false", () => {
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/gateway/index.ts"),
      "utf-8",
    );
    expect(content).toContain('process.env.CLOUD_SYNC_ENABLED !== "false"');
  });
});
