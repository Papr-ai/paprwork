import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_TRACKED_FILE_BYTES,
} from "../src/gateway/services/cloudSync/repoHygiene.js";
import {
  partitionUntrackedBySize,
  stageGitSyncScopes,
} from "../src/gateway/services/cloudSync/gitStageScope.js";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function runGitAsync(cwd: string, args: string[]): Promise<string> {
  return runGit(cwd, args);
}

function stagedFiles(repo: string): string[] {
  const out = runGit(repo, ["diff", "--cached", "--name-only"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

describe("stageGitSyncScopes", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  function initRepo(gitignore?: string): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "papr-git-stage-"));
    tmpDirs.push(repo);
    runGit(repo, ["init", "-q"]);
    runGit(repo, ["config", "user.email", "test@papr.ai"]);
    runGit(repo, ["config", "user.name", "Test"]);
    if (gitignore !== undefined) {
      fs.writeFileSync(path.join(repo, ".gitignore"), gitignore, "utf8");
    }
    return repo;
  }

  it("stages untracked non-ignored files under scope", async () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, "apps", "x"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "x", "app.ts"), "export {};", "utf8");

    await stageGitSyncScopes(
      (args) => runGitAsync(repo, args),
      repo,
      ["apps/x"],
    );

    expect(stagedFiles(repo)).toEqual(["apps/x/app.ts"]);
  });

  it("does not stage gitignored untracked files", async () => {
    const repo = initRepo("**/.versions/\n");
    fs.mkdirSync(path.join(repo, "apps", "x", ".versions"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "apps", "x", ".versions", "a.json"),
      "{}",
      "utf8",
    );
    fs.mkdirSync(path.join(repo, "apps", "x"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "x", "app.ts"), "export {};", "utf8");

    await stageGitSyncScopes(
      (args) => runGitAsync(repo, args),
      repo,
      ["apps/x"],
    );

    const staged = stagedFiles(repo);
    expect(staged).toContain("apps/x/app.ts");
    expect(staged.some((p) => p.includes(".versions"))).toBe(false);
  });

  it("skips oversized untracked files", async () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, "apps", "x", "data"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "x", "main.ts"), "export {};", "utf8");
    fs.writeFileSync(
      path.join(repo, "apps", "x", "data", "big.bin"),
      Buffer.alloc(MAX_TRACKED_FILE_BYTES + 1024),
    );

    const { skippedOversized } = await stageGitSyncScopes(
      (args) => runGitAsync(repo, args),
      repo,
      ["apps/x"],
    );

    expect(stagedFiles(repo)).toContain("apps/x/main.ts");
    expect(stagedFiles(repo)).not.toContain("apps/x/data/big.bin");
    expect(skippedOversized).toContain("apps/x/data/big.bin");
  });

  it("stages deletions for tracked files via git add -u", async () => {
    const repo = initRepo();
    fs.mkdirSync(path.join(repo, "apps", "gone"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "gone", "index.html"), "<html></html>", "utf8");
    runGit(repo, ["add", "apps/gone/index.html"]);
    runGit(repo, ["commit", "-qm", "seed"]);
    fs.rmSync(path.join(repo, "apps", "gone", "index.html"));

    await stageGitSyncScopes(
      (args) => runGitAsync(repo, args),
      repo,
      ["apps/gone"],
    );

    const staged = runGit(repo, ["diff", "--cached", "--name-status"]);
    expect(staged).toContain("D\tapps/gone/index.html");
  });

  it("force-adds mini-app dist when app id is listed", async () => {
    const repo = initRepo("dist/\n");
    const appId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    fs.mkdirSync(path.join(repo, "apps", appId, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "apps", appId, "dist", "app.js"),
      "console.log(1);",
      "utf8",
    );

    await stageGitSyncScopes(
      (args) => runGitAsync(repo, args),
      repo,
      [`apps/${appId}`],
      [appId],
    );

    expect(stagedFiles(repo)).toContain(`apps/${appId}/dist/app.js`);
  });
});

describe("partitionUntrackedBySize", () => {
  it("splits small vs oversized files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-partition-"));
    fs.writeFileSync(path.join(dir, "small.ts"), "x", "utf8");
    fs.writeFileSync(
      path.join(dir, "huge.bin"),
      Buffer.alloc(MAX_TRACKED_FILE_BYTES + 1),
    );

    const { toAdd, skippedOversized } = partitionUntrackedBySize(dir, [
      "small.ts",
      "huge.bin",
    ]);

    expect(toAdd).toEqual(["small.ts"]);
    expect(skippedOversized).toEqual(["huge.bin"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
