import { afterEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  AppRepoOpsConflictResponseSchema,
  AppRepoOpsRequestSchema,
  AppRepoOpsSuccessResponseSchema,
} from "../src/core/types/appRepoWriterOps.js";
import { hashBlobContent } from "../src/gateway/services/syncV3/computeParentHash.js";
import { filterAbusiveOpFiles } from "../src/gateway/services/appRepoWriter/abuseFilter.js";
import {
  getIdempotentOpsResponse,
  storeIdempotentOpsResponse,
  clearIdempotencyCacheForTests,
} from "../src/gateway/services/appRepoWriter/idempotencyCache.js";
import { verifyParentHashes } from "../src/gateway/services/appRepoWriter/parentHashVerify.js";
import { GitRunner } from "../src/gateway/services/cloudSync/gitRunner.js";

describe("app-repo-writer ops contract", () => {
  test("request + success + conflict schemas", () => {
    expect(
      AppRepoOpsRequestSchema.safeParse({
        files: [{ path: "index.html", content: "<html></html>", parentHash: "" }],
        author: "desktop",
        message: "sync",
        idempotencyKey: "key-1",
      }).success,
    ).toBe(true);

    expect(
      AppRepoOpsSuccessResponseSchema.safeParse({
        commitSha: "abc123",
        files: [{ path: "index.html", blobOid: "deadbeef" }],
      }).success,
    ).toBe(true);

    expect(
      AppRepoOpsConflictResponseSchema.safeParse({
        conflict: true,
        artifacts: [
          {
            path: "index.html",
            expectedParentHash: "aaa",
            actualBlobOid: "bbb",
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("abuseFilter", () => {
  test("rejects sqlite and tmp_pack files", () => {
    const { accepted, rejected } = filterAbusiveOpFiles([
      { path: "data.db", content: "binary", parentHash: "" },
      { path: "tmp_pack_abcd", content: "x", parentHash: "" },
      { path: "index.html", content: "<html></html>", parentHash: "" },
    ]);
    expect(accepted.map((file) => file.path)).toEqual(["index.html"]);
    expect(rejected).toHaveLength(2);
  });
});

describe("idempotencyCache", () => {
  afterEach(() => {
    clearIdempotencyCacheForTests();
  });

  test("returns cached success response", () => {
    storeIdempotentOpsResponse("app-1", "idem-1", {
      commitSha: "sha",
      files: [{ path: "a.txt", blobOid: "oid" }],
    });
    expect(getIdempotentOpsResponse("app-1", "idem-1")?.commitSha).toBe("sha");
  });
});

describe("parentHashVerify", () => {
  test("detects mismatch against HEAD", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "writer-verify-"));
    const runner = new GitRunner();
    await runner.run(["init"], { cwd: dir });
    await runner.run(["config", "user.email", "test@papr.ai"], { cwd: dir });
    await runner.run(["config", "user.name", "test"], { cwd: dir });
    await fs.writeFile(path.join(dir, "hello.txt"), "v1", "utf8");
    await runner.run(["add", "hello.txt"], { cwd: dir });
    await runner.run(["commit", "-m", "init"], { cwd: dir });

    const runGit = (args: string[]) => runner.run(args, { cwd: dir });
    const mismatches = await verifyParentHashes(runGit, [
      {
        path: "hello.txt",
        content: "v2",
        parentHash: hashBlobContent("wrong-parent"),
      },
    ]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.path).toBe("hello.txt");
  });
});
