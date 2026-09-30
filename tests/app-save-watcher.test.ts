import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { notifyAppSaveForWriterOps } from "../src/gateway/services/syncV3/AppSaveWatcher.js";
import {
  getAppPublishPrefs,
  setAppPublishPrefs,
} from "../src/gateway/services/cloudPublishPrefs.js";

describe("notifyAppSaveForWriterOps", () => {
  let tmpDir: string;
  let scheduleAutoFlush: ReturnType<typeof vi.fn<(appId: string) => void>>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-save-watcher-"));
    scheduleAutoFlush = vi.fn();
    setAppPublishPrefs(
      "app-manual",
      { uploadMode: "manual", cloudEnabled: true, autoPublish: false },
      tmpDir,
    );
    setAppPublishPrefs(
      "app-auto",
      { uploadMode: "auto", cloudEnabled: true, autoPublish: false },
      tmpDir,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not schedule auto flush when per-app upload mode is manual", async () => {
    const scheduled = await notifyAppSaveForWriterOps(
      "app-manual",
      scheduleAutoFlush,
      tmpDir,
    );
    expect(scheduled).toBe(false);
    expect(scheduleAutoFlush).not.toHaveBeenCalled();
  });

  it("schedules auto flush when per-app upload mode is auto", async () => {
    const scheduled = await notifyAppSaveForWriterOps(
      "app-auto",
      scheduleAutoFlush,
      tmpDir,
    );
    expect(scheduled).toBe(true);
    expect(scheduleAutoFlush).toHaveBeenCalledWith("app-auto");
  });

  it("does not schedule when cloud is disabled for the app", async () => {
    setAppPublishPrefs(
      "app-cloud-off",
      { uploadMode: "auto", cloudEnabled: false, autoPublish: false },
      tmpDir,
    );
    const scheduled = await notifyAppSaveForWriterOps(
      "app-cloud-off",
      scheduleAutoFlush,
      tmpDir,
    );
    expect(scheduled).toBe(false);
    expect(scheduleAutoFlush).not.toHaveBeenCalled();
    expect(getAppPublishPrefs("app-cloud-off", tmpDir).cloudEnabled).toBe(false);
  });
});
