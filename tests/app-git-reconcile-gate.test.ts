import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appDependentPathsNeedGitReconcile,
  listAppDependentSyncRelativePaths,
} from "../src/gateway/services/cloudSync/appGitReconcileGate.js";
import { SyncStateManager } from "../src/gateway/services/cloudSync/syncState.js";

describe("appGitReconcileGate", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists app folder and dependent job paths", () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-gate-"));
    tempDirs.push(paprDir);
    const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    fs.mkdirSync(path.join(paprDir, "apps", appId), { recursive: true });
    fs.mkdirSync(path.join(paprDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(paprDir, "apps", appId, "data-sources.json"),
      JSON.stringify({ sources: [] }),
    );

    const paths = listAppDependentSyncRelativePaths(paprDir, appId);
    expect(paths).toContain(`apps/${appId}`);
  });

  it("needs reconcile when app path was never marked synced", () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-gate-"));
    tempDirs.push(paprDir);
    const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const appDir = path.join(paprDir, "apps", appId);
    fs.mkdirSync(path.join(appDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "src", "App.tsx"), "export {};\n");

    const manager = new SyncStateManager(paprDir);
    expect(
      appDependentPathsNeedGitReconcile(paprDir, appId, manager),
    ).toBe(true);
  });

  it("skips reconcile when app path is marked synced and unchanged", () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-gate-"));
    tempDirs.push(paprDir);
    const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const appDir = path.join(paprDir, "apps", appId);
    fs.mkdirSync(path.join(appDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "src", "App.tsx"), "export {};\n");

    const manager = new SyncStateManager(paprDir);
    manager.markSynced(`apps/${appId}`);
    manager.save();

    expect(
      appDependentPathsNeedGitReconcile(paprDir, appId, manager),
    ).toBe(false);
  });

  it("needs reconcile after disk change following markSynced", () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-gate-"));
    tempDirs.push(paprDir);
    const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const appDir = path.join(paprDir, "apps", appId);
    fs.mkdirSync(path.join(appDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "src", "App.tsx"), "export {};\n");

    const manager = new SyncStateManager(paprDir);
    manager.markSynced(`apps/${appId}`);
    manager.save();

    fs.writeFileSync(path.join(appDir, "src", "App.tsx"), "export { x };\n");

    expect(
      appDependentPathsNeedGitReconcile(paprDir, appId, manager),
    ).toBe(true);
  });
});
