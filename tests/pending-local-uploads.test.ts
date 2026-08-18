import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SyncStateManager } from "../src/gateway/services/cloudSync/syncState.js";
import {
  appHasPendingLocalUpload,
  formatPendingUploadDeferReason,
  hasPendingLocalUploads,
  listPendingUploadRelativePaths,
  readAppHasPendingLocalUpload,
} from "../src/gateway/services/cloudSync/pendingLocalUploads.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `pending-upload-test-${Date.now()}-`),
  );
}

describe("pendingLocalUploads", () => {
  let tmpDir: string;
  let mgr: SyncStateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mgr = new SyncStateManager(tmpDir);
    mgr.load();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns no pending paths when everything is synced", () => {
    const appDir = path.join(tmpDir, "apps", "app-1");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "index.html"), "<p>v1</p>");
    mgr.markSynced("apps/app-1");

    expect(listPendingUploadRelativePaths(tmpDir, mgr)).toEqual([]);
    expect(hasPendingLocalUploads(tmpDir, mgr)).toBe(false);
  });

  it("detects changed app folders awaiting upload", () => {
    const appId = "65b7eb05-5ec0-47da-918a-c63e64916f1e";
    const appDir = path.join(tmpDir, "apps", appId);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "builder-view.ts"), "// v1");
    mgr.markSynced(`apps/${appId}`);

    fs.writeFileSync(path.join(appDir, "builder-view.ts"), "// v2 agent edit");

    expect(listPendingUploadRelativePaths(tmpDir, mgr)).toEqual([
      `apps/${appId}`,
    ]);
    expect(appHasPendingLocalUpload(appId, mgr)).toBe(true);
    expect(readAppHasPendingLocalUpload(appId, tmpDir)).toBe(true);
  });

  it("formats defer reason with preview paths", () => {
    expect(
      formatPendingUploadDeferReason([
        "apps/a",
        "apps/b",
        "apps/c",
        "apps/d",
      ]),
    ).toBe("pending local upload(s): apps/a, apps/b, apps/c (+1 more)");
  });
});
