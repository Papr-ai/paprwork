import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  appRepoCacheKey,
  appRepoCachePath,
  invalidateAppRepoCloneCache,
  isWarmWorkspaceFresh,
  MATERIALIZED_HEAD_FILE,
  readMaterializedHeadSha,
  writeCacheHeadSha,
  writeMaterializedHeadSha,
} from "../src/gateway/services/cloudAgentGateway/appRepoCloneCache.js";

const TEST_SHA = "631d4b8a1234567890abcdef1234567890abcdef";

describe("appRepoCloneCache", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function tempDir(): string {
    const dir = path.join(os.tmpdir(), `papr-clone-cache-test-${Date.now()}-${Math.random()}`);
    tempDirs.push(dir);
    return dir;
  }

  test("appRepoCacheKey is stable for owner/repo/branch", () => {
    const a = appRepoCacheKey("papr-work", "app-ca1ab3b1", "main");
    const b = appRepoCacheKey("papr-work", "app-ca1ab3b1", "main");
    const c = appRepoCacheKey("papr-work", "app-ca1ab3b1", "develop");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("appRepoCachePath includes app- prefix", () => {
    const key = appRepoCacheKey("org", "repo", "main");
    expect(appRepoCachePath("org", "repo", "main")).toContain(`app-${key}`);
  });

  test("writeMaterializedHeadSha round-trips", async () => {
    const paprHome = tempDir();
    await writeMaterializedHeadSha(paprHome, TEST_SHA);
    expect(await readMaterializedHeadSha(paprHome)).toBe(TEST_SHA);
    const raw = await fs.readFile(
      path.join(paprHome, MATERIALIZED_HEAD_FILE),
      "utf8",
    );
    expect(raw).toBe(`${TEST_SHA}\n`);
  });

  test("isWarmWorkspaceFresh returns false without materialized head file", async () => {
    const paprHome = tempDir();
    const fresh = await isWarmWorkspaceFresh({
      paprHome,
      owner: "papr-work",
      repo: "app-test",
      branch: "main",
      token: "unused",
    });
    expect(fresh).toBe(false);
  });

  test("invalidateAppRepoCloneCache removes disk cache directory", async () => {
    const owner = "papr-work";
    const repo = `app-test-${Date.now()}`;
    const cachePath = appRepoCachePath(owner, repo, "main");
    tempDirs.push(cachePath);
    await fs.mkdir(cachePath, { recursive: true });
    await writeCacheHeadSha(cachePath, TEST_SHA);
    await fs.mkdir(path.join(cachePath, "jobs"), { recursive: true });
    await fs.writeFile(path.join(cachePath, "jobs", "job.json"), "{}", "utf8");

    expect(await invalidateAppRepoCloneCache({ owner, repo, branch: "main" })).toBe(true);
    await expect(fs.access(cachePath)).rejects.toThrow();
  });

  test("invalidateAppRepoCloneCache returns false when cache missing", async () => {
    const removed = await invalidateAppRepoCloneCache({
      owner: "missing-org",
      repo: `missing-repo-${Date.now()}`,
      branch: "main",
    });
    expect(removed).toBe(false);
  });
});
