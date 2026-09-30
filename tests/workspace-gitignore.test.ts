import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasMiniAppDistGitignoreExceptions,
  miniAppDistRelativePaths,
  patchWorkspaceGitignore,
  patchWorkspaceGitignoreIfNeeded,
} from "../src/gateway/services/cloudSync/workspaceGitignore.js";

describe("workspaceGitignore", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("detects missing mini-app dist exceptions", () => {
    expect(hasMiniAppDistGitignoreExceptions("**/dist/\n")).toBe(false);
    expect(hasMiniAppDistGitignoreExceptions("!apps/*/dist/\n")).toBe(true);
  });

  it("patches legacy gitignore with dist exceptions and local sync state", () => {
    const legacy = ["**/dist/", "data/jobs.json"].join("\n");
    const patched = patchWorkspaceGitignore(legacy);

    expect(patched).toContain("!apps/*/dist/");
    expect(patched).toContain("!apps/*/dist/**");
    expect(patched).toContain("data/.legacy-home-job-migration.json");
    expect(patched).toContain("Jobs/*/job.runtime.json");
  });

  it("does not duplicate rules when already present", () => {
    const complete = [
      "**/dist/",
      "!apps/*/dist/",
      "!apps/*/dist/**",
      ...["data/.db-memory-sync-state.json", "data/.turso-convergence-state.json"],
      "data/.legacy-home-job-migration.json",
      "data/.gateway-sync-busy.json",
      "Jobs/*/job.runtime.json",
      "data/job-runs.jsonl",
      "**/*.sync-backup-*",
    ].join("\n") + "\n";

    const { changed } = patchWorkspaceGitignoreIfNeeded(complete);
    expect(changed).toBe(false);
  });

  it("returns existing dist dirs for force staging", () => {
    const paprDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-gitignore-"));
    tmpDirs.push(paprDir);

    const appId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
    const distDir = path.join(paprDir, "apps", appId, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "app.js"), "export {};", "utf8");

    expect(miniAppDistRelativePaths(paprDir, [appId])).toEqual([
      `apps/${appId}/dist`,
    ]);
    expect(miniAppDistRelativePaths(paprDir, ["../evil"])).toEqual([]);
    expect(miniAppDistRelativePaths(paprDir, ["missing-app-id"])).toEqual([]);
  });
});
