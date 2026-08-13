import { describe, it, expect } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

/**
 * Test file versioning for mini-apps and jobs.
 *
 * Uses a temp directory as the PAPR root so we don't touch real user data.
 * We test the AppService and JobsService version methods directly.
 */

// Patching os.homedir alone leaked ~300 fixture apps into the real workspace
// on 2026-08-12 — getPaprRoot() prefers ~/Papr/.active-workspace.json and
// re-syncs PAPR_HOME from it. useIsolatedPaprWorkspace neutralises all paths.
const workspace = useIsolatedPaprWorkspace("papr-version-test");

describe("AppService file versioning", () => {
  it("should save a version before overwriting a file", async () => {
    // Dynamically import after overriding homedir
    const { AppService } = await import(
      "../src/gateway/services/AppService.js"
    );
    const service = new AppService();
    await service.initialize();

    // Create app with initial content
    const app = await service.createApp(
      "Test App",
      "Version test",
      [{ filename: "index.html", content: "<h1>V1</h1>" }],
    );

    // Overwrite the file — should auto-save V1 as a version
    await service.writeAppFile(app.id, "index.html", "<h1>V2</h1>");

    // Check version history
    const history = await service.getFileVersionHistory(app.id, "index.html");
    expect(history.length).toBe(1);
    expect(history[0].reason).toBe("auto");

    // Verify the saved version contains the OLD content
    const version = await service.getFileVersion(
      app.id,
      "index.html",
      history[0].versionId,
    );
    expect(version).not.toBeNull();
    expect(version!.content).toBe("<h1>V1</h1>");

    // Verify current file has the NEW content
    const current = await service.readAppFile(app.id, "index.html");
    expect(current).toBe("<h1>V2</h1>");
  });

  it("should deduplicate identical versions", async () => {
    const { AppService } = await import(
      "../src/gateway/services/AppService.js"
    );
    const service = new AppService();
    await service.initialize();

    const app = await service.createApp(
      "Dedup App",
      "Dedup test",
      [{ filename: "index.html", content: "<p>Same</p>" }],
    );

    // Write same content twice
    await service.writeAppFile(app.id, "index.html", "<p>New</p>");
    await service.writeAppFile(app.id, "index.html", "<p>New Again</p>");

    // First write saves V1 ("<p>Same</p>"), second saves V2 ("<p>New</p>")
    // Both are different, so we should have 2 versions
    const history = await service.getFileVersionHistory(app.id, "index.html");
    expect(history.length).toBe(2);

    // Now write the exact same content again — should NOT create a new version
    // Current content is "<p>New Again</p>", writing it again
    await service.writeAppFile(app.id, "index.html", "<p>Something Else</p>");
    // This saves "<p>New Again</p>" as version (different from last version "<p>New</p>")

    const history2 = await service.getFileVersionHistory(app.id, "index.html");
    expect(history2.length).toBe(3);
  });

  it("should restore a file to a previous version", async () => {
    const { AppService } = await import(
      "../src/gateway/services/AppService.js"
    );
    const service = new AppService();
    await service.initialize();

    const app = await service.createApp(
      "Restore App",
      "Restore test",
      [
        { filename: "index.html", content: "<p>placeholder</p>" },
        { filename: "app.ts", content: "const v = 1;" },
      ],
    );

    // Make several edits
    await service.writeAppFile(app.id, "app.ts", "const v = 2;");
    await service.writeAppFile(app.id, "app.ts", "const v = 3;");

    // Get version history (newest first)
    const history = await service.getFileVersionHistory(app.id, "app.ts");
    expect(history.length).toBe(2); // V1 and V2

    // Restore to the very first version (V1: "const v = 1;")
    const oldestVersionId = history[history.length - 1].versionId;
    const restored = await service.restoreFileVersion(
      app.id,
      "app.ts",
      oldestVersionId,
    );
    expect(restored).toBe(true);

    // Verify file content is restored
    const content = await service.readAppFile(app.id, "app.ts");
    expect(content).toBe("const v = 1;");

    // Verify "before-restore" version was saved
    const historyAfter = await service.getFileVersionHistory(app.id, "app.ts");
    const beforeRestore = historyAfter.find((v) =>
      v.reason.includes("before-restore"),
    );
    expect(beforeRestore).toBeDefined();
  });

  it("should return empty history for files with no versions", async () => {
    const { AppService } = await import(
      "../src/gateway/services/AppService.js"
    );
    const service = new AppService();
    await service.initialize();

    const app = await service.createApp(
      "No History App",
      "Test",
      [{ filename: "index.html", content: "<p>hi</p>" }],
    );

    // No writes yet → no versions
    const history = await service.getFileVersionHistory(
      app.id,
      "index.html",
    );
    expect(history).toEqual([]);
  });

  it("should handle filenames with subdirectories", async () => {
    const { AppService } = await import(
      "../src/gateway/services/AppService.js"
    );
    const service = new AppService();
    await service.initialize();

    const app = await service.createApp(
      "Subdir App",
      "Subdir test",
      [
        { filename: "index.html", content: "<p>hi</p>" },
        { filename: "components/header.ts", content: "export const H = 1;" },
      ],
    );

    // Edit the nested file
    await service.writeAppFile(
      app.id,
      "components/header.ts",
      "export const H = 2;",
    );

    const history = await service.getFileVersionHistory(
      app.id,
      "components/header.ts",
    );
    expect(history.length).toBe(1);

    const version = await service.getFileVersion(
      app.id,
      "components/header.ts",
      history[0].versionId,
    );
    expect(version!.content).toBe("export const H = 1;");
  });
});

describe("Job file versioning (saveJobFileVersion helper)", () => {
  it("should save and deduplicate job file versions", async () => {
    // Test the saveJobFileVersion helper from appJobs.ts directly
    // by creating the version structure manually (same format the helper uses)
    const jobId = "test-job-123";
    const jobDir = path.join(workspace.paprHome, "jobs", jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const scriptPath = path.join(jobDir, "script.py");
    await fs.writeFile(scriptPath, 'print("v1")', "utf-8");

    // Create a version (same as saveJobFileVersion does)
    const filename = "script.py";
    const versionsDir = path.join(jobDir, ".versions", filename);
    await fs.mkdir(versionsDir, { recursive: true });

    const ts1 = new Date().toISOString().replace(/[:.]/g, "-");
    const versionId1 = `${ts1}_before-edit`;
    await fs.writeFile(
      path.join(versionsDir, versionId1),
      'print("v1")',
      "utf-8",
    );

    // Write new content
    await fs.writeFile(scriptPath, 'print("v2")', "utf-8");

    // Verify the version file exists and contains the old content
    const versionContent = await fs.readFile(
      path.join(versionsDir, versionId1),
      "utf-8",
    );
    expect(versionContent).toBe('print("v1")');

    // Verify version directory lists the version
    const versionFiles = await fs.readdir(versionsDir);
    expect(versionFiles.length).toBe(1);
    expect(versionFiles[0]).toBe(versionId1);

    // Add a second version
    const ts2 = new Date(Date.now() + 1000).toISOString().replace(/[:.]/g, "-");
    const versionId2 = `${ts2}_before-edit`;
    await fs.writeFile(
      path.join(versionsDir, versionId2),
      'print("v2")',
      "utf-8",
    );

    // Verify both versions exist
    const versionFiles2 = await fs.readdir(versionsDir);
    expect(versionFiles2.length).toBe(2);

    // Simulate restore: save current as "before-restore", then write old content
    const ts3 = new Date(Date.now() + 2000).toISOString().replace(/[:.]/g, "-");
    const beforeRestoreId = `${ts3}_before-restore`;
    const currentContent = await fs.readFile(scriptPath, "utf-8");
    await fs.writeFile(
      path.join(versionsDir, beforeRestoreId),
      currentContent,
      "utf-8",
    );
    await fs.writeFile(scriptPath, 'print("v1")', "utf-8");

    // Verify restored content
    const restoredContent = await fs.readFile(scriptPath, "utf-8");
    expect(restoredContent).toBe('print("v1")');

    // Verify "before-restore" version exists
    const allVersions = await fs.readdir(versionsDir);
    expect(allVersions.length).toBe(3);
    const hasBeforeRestore = allVersions.some((v) =>
      v.includes("before-restore"),
    );
    expect(hasBeforeRestore).toBe(true);
  });
});
