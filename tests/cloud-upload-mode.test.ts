import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isCloudAutoUploadGloballyEnabled,
  shouldAutoUploadApp,
  shouldAutoUploadJobFolder,
  shouldAutoUploadRelativePath,
} from "../src/gateway/services/cloudUploadMode.js";
import { saveCloudPublishPrefs } from "../src/gateway/services/cloudPublishPrefs.js";

describe("cloudUploadMode", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  function makePaprDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-upload-mode-"));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.mkdirSync(path.join(dir, "apps", "app-manual"), { recursive: true });
    fs.mkdirSync(path.join(dir, "Jobs", "job-1"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "apps", "app-manual", "data-sources.json"),
      JSON.stringify({ sources: [{ jobId: "job-1", alias: "main" }] }),
    );
    return dir;
  }

  it("defaults global auto-upload to disabled", () => {
    const settingsPath = path.join(os.tmpdir(), `settings-${Date.now()}.json`);
    expect(isCloudAutoUploadGloballyEnabled(settingsPath)).toBe(false);
  });

  it("respects global cloudAutoUploadEnabled=false", () => {
    const settingsPath = path.join(os.tmpdir(), `settings-${Date.now()}.json`);
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ preferences: { cloudAutoUploadEnabled: false } }),
    );
    expect(isCloudAutoUploadGloballyEnabled(settingsPath)).toBe(false);
  });

  it("blocks auto upload for manual per-app mode", () => {
    const paprDir = makePaprDir();
    saveCloudPublishPrefs(
      {
        apps: {
          "app-manual": {
            autoPublish: true,
            accessMode: "private",
            uploadMode: "manual",
          },
        },
      },
      paprDir,
    );
    expect(shouldAutoUploadApp("app-manual", paprDir)).toBe(false);
    expect(shouldAutoUploadRelativePath("apps/app-manual", paprDir)).toBe(false);
    expect(shouldAutoUploadJobFolder("job-1", paprDir)).toBe(false);
  });

  it("allows auto upload when per-app mode is auto", () => {
    const paprDir = makePaprDir();
    saveCloudPublishPrefs(
      {
        apps: {
          "app-manual": {
            autoPublish: true,
            accessMode: "private",
            uploadMode: "auto",
          },
        },
      },
      paprDir,
    );
    expect(shouldAutoUploadApp("app-manual", paprDir)).toBe(true);
  });
});
