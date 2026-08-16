import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  shouldExcludePathFromContentHash,
  SyncStateManager,
} from "../src/gateway/services/cloudSync/syncState.js";

describe("shouldExcludePathFromContentHash", () => {
  it("excludes cloud-prep artifact paths", () => {
    expect(shouldExcludePathFromContentHash("apps/x/backend/bundle.json")).toBe(true);
    expect(shouldExcludePathFromContentHash("apps/x/requirements.json")).toBe(true);
    expect(shouldExcludePathFromContentHash("data/cloud-repo-head.txt")).toBe(true);
    expect(shouldExcludePathFromContentHash("apps/x/linked-databases.json")).toBe(true);
    expect(shouldExcludePathFromContentHash("apps/x/src/App.tsx")).toBe(false);
    expect(shouldExcludePathFromContentHash("Jobs/job-1/job.runtime.json")).toBe(
      true,
    );
    expect(shouldExcludePathFromContentHash("data/job-runs.jsonl")).toBe(true);
  });

  it("excludes local-only backup artifacts", () => {
    expect(
      shouldExcludePathFromContentHash(
        "data/databases/gtm-foundations/data.db.corrupt-1785826750.bak",
      ),
    ).toBe(true);
    expect(
      shouldExcludePathFromContentHash(
        "Jobs/job-1/data/data.db.corrupt-backup-2026-04-01T12-00-00",
      ),
    ).toBe(true);
    expect(
      shouldExcludePathFromContentHash(
        "data/databases/joe-coffee-intelligence/data.db.sync-backup-1786575688502",
      ),
    ).toBe(true);
    expect(shouldExcludePathFromContentHash("data/apps.json.corrupt-1234567890")).toBe(
      true,
    );
    expect(shouldExcludePathFromContentHash("data/settings.json")).toBe(false);
    expect(
      shouldExcludePathFromContentHash(
        "data/brand/revenue-reimagined/source/RR-Brand-Guidelines.pdf",
      ),
    ).toBe(false);
  });
});

describe("SyncStateManager content hash", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores cloud-prep artifacts when hashing app folders", () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sync-hash-"));
    tempDirs.push(paprDir);
    const appDir = path.join(paprDir, "apps", "app-1");
    fs.mkdirSync(path.join(appDir, "backend"), { recursive: true });
    fs.mkdirSync(path.join(appDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "src", "App.tsx"), "export {};\n");
    fs.writeFileSync(path.join(appDir, "requirements.json"), "[]\n");

    const manager = new SyncStateManager(paprDir);
    const hashBefore = manager.computeContentHash("apps/app-1");

    fs.writeFileSync(
      path.join(appDir, "backend", "bundle.json"),
      JSON.stringify({ handlers: ["a"] }),
    );
    fs.writeFileSync(path.join(appDir, "requirements.json"), JSON.stringify(["x"]));

    const hashAfterPrep = manager.computeContentHash("apps/app-1");
    expect(hashAfterPrep).toBe(hashBefore);

    fs.writeFileSync(path.join(appDir, "src", "App.tsx"), "export const x = 1;\n");
    const hashAfterSource = manager.computeContentHash("apps/app-1");
    expect(hashAfterSource).not.toBe(hashBefore);
  });

  it("records and clears dead-letter items", () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-sync-dead-"));
    tempDirs.push(paprDir);
    const manager = new SyncStateManager(paprDir);
    manager.load();

    expect(manager.isDeadLetter("apps/broken")).toBe(false);
    manager.recordDeadLetter("apps/broken", "push failed", 3);
    expect(manager.isDeadLetter("apps/broken")).toBe(true);
    expect(manager.getDeadLetter("apps/broken")?.lastError).toBe("push failed");

    manager.markSynced("apps/broken");
    expect(manager.isDeadLetter("apps/broken")).toBe(false);
  });
});
