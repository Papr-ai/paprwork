/**
 * Real-git integration tests for metadata auto-merge classification.
 * Verifies three-dot diff when desktop and cloud branches diverge.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyIncomingRemoteChanges,
  listIncomingRemoteChangedPaths,
  mergeRemoteMainIntoLocal,
  type RunGitFn,
} from "../src/gateway/services/cloudSync/gitRemoteReconcile.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Papr Test",
  GIT_AUTHOR_EMAIL: "sync-test@papr.ai",
  GIT_COMMITTER_NAME: "Papr Test",
  GIT_COMMITTER_EMAIL: "sync-test@papr.ai",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv,
  }).trimEnd();
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function makeRunGit(repoDir: string): RunGitFn {
  return async (args, opts) => {
    if (args[0] === "fetch") {
      git(repoDir, args);
      return "";
    }
    return git(repoDir, args);
  };
}

describe.skipIf(!hasGit())("git remote reconcile (real git)", () => {
  let root: string;
  let desktopDir: string;
  let cloudDir: string;
  let bareDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "papr-git-reconcile-"));
    desktopDir = path.join(root, "desktop");
    cloudDir = path.join(root, "cloud");
    bareDir = path.join(root, "remote.git");

    fs.mkdirSync(desktopDir, { recursive: true });
    git(desktopDir, ["init", "-b", "main"]);
    fs.writeFileSync(path.join(desktopDir, "README.md"), "base\n", "utf8");
    git(desktopDir, ["add", "."]);
    git(desktopDir, ["commit", "-m", "init"]);

    git(desktopDir, ["clone", "--bare", ".", bareDir]);
    git(desktopDir, ["remote", "add", "origin", bareDir]);
    git(desktopDir, ["push", "-u", "origin", "main"]);

    git(desktopDir, ["clone", bareDir, cloudDir]);
    git(cloudDir, ["config", "user.name", "Cloud"]);
    git(cloudDir, ["config", "user.email", "cloud@papr.ai"]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("classifies diverged remote job status as metadata-only (three-dot)", async () => {
    const jobDir = path.join(cloudDir, "Jobs", "job-1");
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(
      path.join(jobDir, "job.json"),
      JSON.stringify({ status: "running", lastRunAt: "2026-08-11T00:00:00.000Z" }),
      "utf8",
    );
    fs.mkdirSync(path.join(desktopDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(desktopDir, "data", "jobs.json"),
      JSON.stringify([{ id: "job-1", status: "idle" }]),
      "utf8",
    );
    git(cloudDir, ["add", "Jobs/job-1/job.json"]);
    git(cloudDir, ["commit", "-m", "cloud: update job job-1 status"]);
    git(cloudDir, ["push", "origin", "main"]);

    const appDir = path.join(desktopDir, "apps", "app-1");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "index.html"), "<h1>local</h1>", "utf8");
    git(desktopDir, ["add", "apps/app-1/index.html"]);
    git(desktopDir, ["commit", "-m", "local app change"]);

    git(desktopDir, ["fetch", "origin", "main"]);

    const twoDot = git(desktopDir, [
      "diff",
      "--name-only",
      "HEAD..origin/main",
    ]);
    expect(twoDot.split("\n").filter(Boolean)).toContain("apps/app-1/index.html");

    const runGit = makeRunGit(desktopDir);
    const remotePaths = await listIncomingRemoteChangedPaths(runGit);
    expect(remotePaths).toEqual(["Jobs/job-1/job.json"]);
    expect(await classifyIncomingRemoteChanges(runGit)).toBe(
      "runtime_metadata_only",
    );
  });

  it("auto-merges metadata-only remote then allows push", async () => {
    const jobDir = path.join(cloudDir, "Jobs", "job-2");
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(
      path.join(jobDir, "job.json"),
      JSON.stringify({ status: "completed" }),
      "utf8",
    );
    git(cloudDir, ["add", "Jobs/job-2/job.json"]);
    git(cloudDir, ["commit", "-m", "cloud: update job job-2 status"]);
    git(cloudDir, ["push", "origin", "main"]);

    const appDir = path.join(desktopDir, "apps", "app-2");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "index.html"), "<p>v2</p>", "utf8");
    git(desktopDir, ["add", "apps/app-2/index.html"]);
    git(desktopDir, ["commit", "-m", "local app v2"]);
    git(desktopDir, ["fetch", "origin", "main"]);

    const runGit = makeRunGit(desktopDir);
    expect(await classifyIncomingRemoteChanges(runGit)).toBe(
      "runtime_metadata_only",
    );

    await mergeRemoteMainIntoLocal(runGit, {
      stashMessage: "test-auto-reconcile",
    });

    git(desktopDir, ["push", "-u", "origin", "main"]);

    const behind = git(desktopDir, ["rev-list", "--count", "HEAD..origin/main"]);
    const ahead = git(desktopDir, ["rev-list", "--count", "origin/main..HEAD"]);
    expect(behind).toBe("0");
    expect(ahead).toBe("0");

    const mergedJob = JSON.parse(
      fs.readFileSync(path.join(desktopDir, "Jobs", "job-2", "job.json"), "utf8"),
    ) as { status: string };
    expect(mergedJob.status).toBe("completed");
    expect(fs.existsSync(path.join(desktopDir, "apps", "app-2", "index.html"))).toBe(
      true,
    );
  });

  it("requires review when remote changed app source code", async () => {
    const appDir = path.join(cloudDir, "apps", "shared-app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "index.html"), "<h1>cloud</h1>", "utf8");
    git(cloudDir, ["add", "apps/shared-app/index.html"]);
    git(cloudDir, ["commit", "-m", "cloud: update app"]);
    git(cloudDir, ["push", "origin", "main"]);

    const localAppDir = path.join(desktopDir, "apps", "shared-app");
    fs.mkdirSync(localAppDir, { recursive: true });
    fs.writeFileSync(path.join(localAppDir, "index.html"), "<h1>local</h1>", "utf8");
    git(desktopDir, ["add", "apps/shared-app/index.html"]);
    git(desktopDir, ["commit", "-m", "local app edit"]);
    git(desktopDir, ["fetch", "origin", "main"]);

    const runGit = makeRunGit(desktopDir);
    expect(await classifyIncomingRemoteChanges(runGit)).toBe("requires_review");
  });

  it("merges when many job.json files are dirty locally (metadata restore)", async () => {
    for (let i = 0; i < 55; i += 1) {
      const jobId = `job-${i}`;
      const jobDir = path.join(desktopDir, "Jobs", jobId);
      fs.mkdirSync(jobDir, { recursive: true });
      fs.writeFileSync(
        path.join(jobDir, "job.json"),
        JSON.stringify({ status: "idle", id: jobId }),
        "utf8",
      );
    }
    git(desktopDir, ["add", "Jobs"]);
    git(desktopDir, ["commit", "-m", "seed jobs"]);
    git(desktopDir, ["push", "origin", "main"]);

    git(cloudDir, ["fetch", "origin", "main"]);
    git(cloudDir, ["reset", "--hard", "origin/main"]);

    for (let i = 0; i < 55; i += 1) {
      const jobId = `job-${i}`;
      fs.writeFileSync(
        path.join(cloudDir, "Jobs", jobId, "job.json"),
        JSON.stringify({ status: "completed", id: jobId }),
        "utf8",
      );
    }
    git(cloudDir, ["add", "Jobs"]);
    git(cloudDir, ["commit", "-m", "cloud: update job batch status"]);
    git(cloudDir, ["push", "origin", "main"]);

    for (let i = 0; i < 55; i += 1) {
      const jobId = `job-${i}`;
      fs.writeFileSync(
        path.join(desktopDir, "Jobs", jobId, "job.json"),
        JSON.stringify({ status: "running", id: jobId }),
        "utf8",
      );
    }
    fs.mkdirSync(path.join(desktopDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(desktopDir, "data", "jobs.json"),
      JSON.stringify([{ id: "job-0", status: "running" }]),
      "utf8",
    );
    git(desktopDir, ["add", "data/jobs.json"]);
    git(desktopDir, ["commit", "-m", "local jobs index dirty"]);

    git(desktopDir, ["fetch", "origin", "main"]);
    const runGit = makeRunGit(desktopDir);

    const mergeResult = await mergeRemoteMainIntoLocal(runGit, {
      stashMessage: "test-many-job-json",
    });
    expect(mergeResult.restoredMetadataPaths).toBeGreaterThanOrEqual(55);
    expect(mergeResult.stashedSourcePaths).toBe(0);

    const sampleJob = JSON.parse(
      fs.readFileSync(path.join(desktopDir, "Jobs", "job-0", "job.json"), "utf8"),
    ) as { status: string };
    expect(sampleJob.status).toBe("completed");
  });
});
