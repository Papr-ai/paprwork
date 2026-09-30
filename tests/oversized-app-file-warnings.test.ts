import { describe, expect, it } from "vitest";

import {
  buildLargeContentWriteReminder,
  extractAppIdFromAppsPath,
  looksLikeAppFolderWrite,
} from "../src/core/utils/oversizedAppFileWarnings.js";
import { buildOversizedAppFilesReport } from "../src/gateway/services/cloudSync/oversizedAppFilesReport.js";
import { MAX_GIT_SYNC_FILE_BYTES } from "../src/gateway/services/cloudSync/gitSyncLimits.js";
import { listOversizedFilesInAppDir } from "../src/gateway/services/syncV3/collectAppOpFiles.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("oversizedAppFileWarnings", () => {
  it("detects app folder write commands", () => {
    expect(
      looksLikeAppFolderWrite(
        "cp demo.mp4 $PAPR_HOME/apps/abc-123/assets/demo.mp4",
      ),
    ).toBe(true);
    expect(looksLikeAppFolderWrite("grep -r foo apps/")).toBe(false);
  });

  it("extracts app id from path", () => {
    const appId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
    expect(
      extractAppIdFromAppsPath(`/Users/me/Papr/apps/${appId}/assets/x.mp4`),
    ).toBe(appId);
  });

  it("buildLargeContentWriteReminder mentions App Files", () => {
    const message = buildLargeContentWriteReminder("assets/demo.mp4");
    expect(message).toContain("App Files");
    expect(message).toContain("APP_FILES_GUIDE");
  });
});

describe("listOversizedFilesInAppDir", () => {
  it("finds files over the git sync limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "papr-oversized-"));
    const appDir = path.join(root, "app");
    await mkdir(path.join(appDir, "assets"), { recursive: true });
    await writeFile(path.join(appDir, "small.txt"), "ok");
    await writeFile(
      path.join(appDir, "assets", "large.bin"),
      Buffer.alloc(MAX_GIT_SYNC_FILE_BYTES + 1),
    );

    const found = await listOversizedFilesInAppDir(appDir);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("assets/large.bin");
  });
});

describe("buildOversizedAppFilesReport", () => {
  it("returns null when no oversized files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "papr-oversized-report-"));
    const appId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
    const appDir = path.join(root, "apps", appId);
    await mkdir(appDir, { recursive: true });
    await writeFile(path.join(appDir, "index.html"), "<html></html>");

    const report = await buildOversizedAppFilesReport(root, appId);
    expect(report).toBeNull();
  });

  it("returns message when oversized files exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "papr-oversized-report2-"));
    const appId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
    const appDir = path.join(root, "apps", appId);
    await mkdir(appDir, { recursive: true });
    await writeFile(
      path.join(appDir, "clip.mp4"),
      Buffer.alloc(1024),
    );

    const report = await buildOversizedAppFilesReport(root, appId);
    expect(report?.paths).toHaveLength(1);
    expect(report?.message).toContain("App Files");
    expect(report?.message).toContain("apps/");
  });
});
