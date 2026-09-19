import { afterEach, describe, expect, it } from "vitest";

import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import {
  clearOidCacheForTests,
  getCachedBlobOid,
  readOidCache,
} from "../src/gateway/services/syncV3/OidCache.js";
import {
  oidCacheNeedsRealignWithHead,
  reconcileOidCacheWithRemoteHead,
} from "../src/gateway/services/syncV3/writerBaselineReconcile.js";
import { hashBlobContent } from "../src/gateway/services/syncV3/computeParentHash.js";
import { collectAppOpFiles } from "../src/gateway/services/syncV3/collectAppOpFiles.js";
import { verifyParentHashes } from "../src/gateway/services/appRepoWriter/parentHashVerify.js";
import { GitRunner } from "../src/gateway/services/cloudSync/gitRunner.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("oidCacheNeedsRealignWithHead", () => {
  it("returns false when remote HEAD has no files", () => {
    expect(oidCacheNeedsRealignWithHead({}, [])).toBe(false);
    expect(oidCacheNeedsRealignWithHead(undefined, [])).toBe(false);
  });

  it("returns true when cache is empty but remote has files", () => {
    expect(
      oidCacheNeedsRealignWithHead(undefined, [
        { path: "README.md", blobOid: "aaa" },
      ]),
    ).toBe(true);
    expect(
      oidCacheNeedsRealignWithHead({}, [{ path: "README.md", blobOid: "aaa" }]),
    ).toBe(true);
  });

  it("returns true when a HEAD path OID differs from cache", () => {
    expect(
      oidCacheNeedsRealignWithHead(
        { "README.md": "stale" },
        [{ path: "README.md", blobOid: "fresh" }],
      ),
    ).toBe(true);
  });

  it("returns false when every HEAD path matches cache", () => {
    expect(
      oidCacheNeedsRealignWithHead(
        {
          "README.md": "aaa",
          "index.html": "bbb",
          "extra-local-only": "ccc",
        },
        [
          { path: "README.md", blobOid: "aaa" },
          { path: "index.html", blobOid: "bbb" },
        ],
      ),
    ).toBe(false);
  });
});

describe("reconcileOidCacheWithRemoteHead", () => {
  useIsolatedPaprWorkspace("writer-baseline-reconcile");

  afterEach(async () => {
    await clearOidCacheForTests();
  });

  it("seeds cache from HEAD so later ops use correct parentHash", async () => {
    const appId = "fb77e665-eeb5-4bee-8578-e16c1a0b9b6b";
    const headFiles = [
      { path: "README.md", blobOid: "1111111111111111111111111111111111111111" },
    ];

    const result = await reconcileOidCacheWithRemoteHead(appId, headFiles);
    expect(result).toEqual({ realigned: true, pathsUpdated: 1 });

    expect(await getCachedBlobOid(appId, "README.md")).toBe(
      "1111111111111111111111111111111111111111",
    );

    const second = await reconcileOidCacheWithRemoteHead(appId, headFiles);
    expect(second.realigned).toBe(false);
    expect(second.pathsUpdated).toBe(0);
  });

  it("replaces stale OIDs for paths on HEAD", async () => {
    const appId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const cache = await readOidCache();
    cache.apps[appId] = { "README.md": "staleoid1111111111111111111111111111111111" };
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { getPaprRoot } = await import("../src/core/utils/paprRoot.js");
    const dataDir = join(getPaprRoot(), "data");
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "sync-oid-cache.json"),
      JSON.stringify(cache, null, 2),
      "utf8",
    );

    const headFiles = [
      { path: "README.md", blobOid: "freshoid2222222222222222222222222222222222" },
    ];
    const result = await reconcileOidCacheWithRemoteHead(appId, headFiles);
    expect(result.realigned).toBe(true);
    expect(await getCachedBlobOid(appId, "README.md")).toBe(
      "freshoid2222222222222222222222222222222222",
    );
  });

  it("after reconcile, collect sends parentHash from HEAD not empty string", async () => {
    const appId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const { getPaprRoot } = await import("../src/core/utils/paprRoot.js");
    const paprRoot = getPaprRoot();
    const appDir = path.join(paprRoot, "apps", appId);
    await fs.mkdir(appDir, { recursive: true });
    const remoteReadme = "# Cloud README\n";
    const localReadme = "# Local README\n";
    await fs.writeFile(path.join(appDir, "README.md"), localReadme, "utf8");

    const remoteOid = hashBlobContent(remoteReadme);
    await reconcileOidCacheWithRemoteHead(appId, [
      { path: "README.md", blobOid: remoteOid },
    ]);

    const collected = await collectAppOpFiles(paprRoot, appId);
    const readmeOp = collected.files.find((file) => file.path === "README.md");
    expect(readmeOp).toBeDefined();
    expect(readmeOp?.parentHash).toBe(remoteOid);
    expect(readmeOp?.parentHash).not.toBe("");

    const gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "writer-baseline-git-"));
    const runner = new GitRunner();
    await runner.run(["init"], { cwd: gitDir });
    await runner.run(["config", "user.email", "test@papr.ai"], { cwd: gitDir });
    await runner.run(["config", "user.name", "test"], { cwd: gitDir });
    await fs.writeFile(path.join(gitDir, "README.md"), remoteReadme, "utf8");
    await runner.run(["add", "README.md"], { cwd: gitDir });
    await runner.run(["commit", "-m", "init"], { cwd: gitDir });
    const runGit = (args: string[]) => runner.run(args, { cwd: gitDir });
    const mismatches = await verifyParentHashes(runGit, [readmeOp!]);
    expect(mismatches).toHaveLength(0);
  });
});
