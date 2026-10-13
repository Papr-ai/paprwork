import { describe, expect, it } from "vitest";

import {
  appSourceRepoRelativeDir,
  isAppRepoRootPath,
  isGitRepositoryNotFoundError,
  linkedJobRepoRelativeDir,
  redactGitCloneErrorMessage,
} from "../src/gateway/services/cloudSync/cloudGitClone.js";

describe("cloudGitClone helpers", () => {
  it("detects app repo root paths", () => {
    expect(isAppRepoRootPath(".")).toBe(true);
    expect(isAppRepoRootPath("")).toBe(true);
    expect(isAppRepoRootPath("apps/app-1")).toBe(false);
  });

  it("maps contribute staging paths for legacy vs app repos", () => {
    expect(appSourceRepoRelativeDir(".", "app-1")).toBe(".");
    expect(appSourceRepoRelativeDir("apps/app-1", "app-1")).toBe("apps/app-1");
    expect(linkedJobRepoRelativeDir(".", "job-1")).toBe("jobs/job-1");
    expect(linkedJobRepoRelativeDir("apps/app-1", "job-1")).toBe("Jobs/job-1");
  });

  it("detects missing GitHub repos from clone errors", () => {
    const err = new Error(
      "git clone failed (128): remote: Repository not found.\nfatal: repository 'https://github.com/papr-work/app-x.git/' not found",
    );
    expect(isGitRepositoryNotFoundError(err)).toBe(true);
    expect(isGitRepositoryNotFoundError(new Error("timed out"))).toBe(false);
  });

  it("redacts git tokens from clone error messages", () => {
    const raw =
      "git clone https://x-access-token:ghs_secret@github.com/papr-work/app-x.git failed";
    expect(redactGitCloneErrorMessage(raw)).toBe(
      "git clone https://***@github.com/papr-work/app-x.git failed",
    );
  });
});

describe("checkoutPublishedCommit", () => {
  it("moves a shallow clone to the pinned commit, and keeps HEAD when it can't", async () => {
    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { checkoutPublishedCommit } = await import(
      "../src/gateway/services/cloudSync/cloudGitClone.js"
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pin-"));
    const origin = path.join(root, "origin");
    const clone = path.join(root, "clone");
    await fs.mkdir(origin);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.email", "t@t");
    git(origin, "config", "user.name", "t");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    await fs.writeFile(path.join(origin, "app.ts"), "v1");
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "v1");
    const v1 = git(origin, "rev-parse", "HEAD");
    await fs.writeFile(path.join(origin, "app.ts"), "v2 (still uploading)");
    git(origin, "commit", "-qam", "v2");
    git(root, "clone", "-q", "--depth", "1", `file://${origin}`, clone);
    const read = () => fs.readFile(path.join(clone, "app.ts"), "utf8");

    await checkoutPublishedCommit(clone, "f".repeat(40), process.env);
    expect(await read()).toBe("v2 (still uploading)");

    await checkoutPublishedCommit(clone, undefined, process.env);
    expect(await read()).toBe("v2 (still uploading)");

    await checkoutPublishedCommit(clone, v1, process.env);
    expect(await read()).toBe("v1");
    await fs.rm(root, { recursive: true, force: true });
  }, 30_000);
});
