import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  installCommitFor,
  schemaBehindPublish,
} from "../../../src/gateway/services/cloudSync/publishCompletion.js";
import { checkoutPublishedCommit } from "../../../src/gateway/services/cloudSync/cloudGitClone.js";

describe("installCommitFor", () => {
  it("uses the finished publish's commit", () => {
    expect(installCommitFor({ publishedRevision: { commit: "abc1234" } })).toEqual({ commit: "abc1234", blocked: false });
  });
  it("blocks a first publish still uploading", () => {
    expect(installCommitFor({ publishPending: true })).toEqual({ commit: null, blocked: true });
  });
  it("republish in flight still installs the last finished commit", () => {
    expect(installCommitFor({ publishPending: true, publishedRevision: { commit: "abc1234" } }).commit).toBe("abc1234");
  });
  it("legacy publish (no record) falls back to HEAD", () => {
    expect(installCommitFor({})).toEqual({ commit: null, blocked: false });
  });
});

describe("schemaBehindPublish", () => {
  it("flags only databases whose cloud schema is older than the publish", () => {
    expect(
      schemaBehindPublish(
        { "db-a": "0003_x", "db-b": "0002_y", "db-c": "0001_z" },
        { "db-a": "0002_w", "db-b": "0002_y" },
      ),
    ).toEqual(["db-a"]);
  });
});

describe("checkoutPublishedCommit", () => {
  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pub-commit-"));
    const repo = path.join(root, "origin");
    await fs.mkdir(repo);
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env }).toString().trim();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "uploadpack.allowAnySHA1InWant", "true");
    git(repo, "config", "uploadpack.allowFilter", "true");
    await fs.writeFile(path.join(repo, "app.ts"), "v1");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "v1");
    const published = git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "app.ts"), "v2-mid-upload");
    git(repo, "commit", "-qam", "v2");
    return { root, repo, published, git, env };
  }

  it("shallow clone moves to the published commit, not HEAD", async () => {
    const { root, repo, published, git, env } = await fixture();
    const dir = path.join(root, "clone");
    git(root, "clone", "-q", "--depth", "1", "--filter=blob:none", `file://${repo}`, dir);
    expect(await fs.readFile(path.join(dir, "app.ts"), "utf8")).toBe("v2-mid-upload");
    await checkoutPublishedCommit(dir, published, env, true);
    expect(await fs.readFile(path.join(dir, "app.ts"), "utf8")).toBe("v1");
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("keeps HEAD (no throw) when the commit doesn't exist", async () => {
    const { root, repo, git, env } = await fixture();
    const dir = path.join(root, "clone");
    git(root, "clone", "-q", "--depth", "1", `file://${repo}`, dir);
    await checkoutPublishedCommit(dir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", env, true);
    expect(await fs.readFile(path.join(dir, "app.ts"), "utf8")).toBe("v2-mid-upload");
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
});

import { stripDbIdFolderSuffix } from "../../../src/gateway/services/CloudAppContributeService.js";
describe("stripDbIdFolderSuffix", () => {
  it("maps a collision-suffixed folder back to the publisher's slug", () => {
    expect(stripDbIdFolderSuffix("data/databases/linkedin-outreach-v2-59e5ad02", "db-59e5ad02")).toBe("data/databases/linkedin-outreach-v2");
    expect(stripDbIdFolderSuffix("data/databases/scout-db", "db-48497808")).toBe("data/databases/scout-db");
  });
});
