import { afterEach, describe, expect, it } from "vitest";

import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import {
  getCachedBlobOid,
  overwriteOidCacheFromHead,
  readOidCache,
  clearOidCacheForTests,
} from "../src/gateway/services/syncV3/OidCache.js";
import {
  appendOutboxEntry,
  clearSyncOutboxForTests,
  clearWriterOutboxFailureEntries,
  listOutboxEntries,
  markOutboxDeadLetter,
  markOutboxFailed,
} from "../src/gateway/services/syncV3/SyncOutbox.js";
import {
  clearWriterConflictsForApp,
  clearWriterConflictsForTests,
  invalidateWriterConflictPaths,
  listRecentWriterConflicts,
} from "../src/gateway/services/syncV3/writerConflict.js";

describe("overwriteOidCacheFromHead", () => {
  useIsolatedPaprWorkspace("reset-writer-baseline-oid");

  afterEach(async () => {
    await clearOidCacheForTests();
  });

  it("replaces stale cached OIDs with writer HEAD", async () => {
    const appId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const cache = await readOidCache();
    cache.apps[appId] = {
      "dist/app.js": "staleoid1111111111111111111111111111111111",
    };
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

    const count = await overwriteOidCacheFromHead(appId, [
      { path: "dist/app.js", blobOid: "freshoid2222222222222222222222222222222222" },
      { path: ".papr-cloud-revision", blobOid: "rev000000000000000000000000000000000000" },
    ]);

    expect(count).toBe(2);
    expect(await getCachedBlobOid(appId, "dist/app.js")).toBe(
      "freshoid2222222222222222222222222222222222",
    );
    expect(await getCachedBlobOid(appId, ".papr-cloud-revision")).toBe(
      "rev000000000000000000000000000000000000",
    );
  });
});

describe("clearWriterOutboxFailureEntries", () => {
  useIsolatedPaprWorkspace("reset-writer-baseline-outbox");

  afterEach(async () => {
    await clearSyncOutboxForTests();
  });

  it("removes dead-letter and failed entries for one app", async () => {
    const appA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const appB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const dead = await appendOutboxEntry({
      appId: appA,
      files: [],
      author: "test",
      message: "dead",
    });
    await markOutboxDeadLetter(dead.id, "conflict");

    const failed = await appendOutboxEntry({
      appId: appA,
      files: [],
      author: "test",
      message: "failed-retry",
    });
    await markOutboxFailed(failed.id, "network");

    await appendOutboxEntry({
      appId: appB,
      files: [],
      author: "test",
      message: "other",
    });

    const removed = await clearWriterOutboxFailureEntries(appA);
    expect(removed).toBe(2);
    expect(await listOutboxEntries(appA)).toHaveLength(0);
    expect(await listOutboxEntries(appB)).toHaveLength(1);
  });
});

describe("clearWriterConflictsForApp", () => {
  afterEach(() => {
    clearWriterConflictsForTests();
  });

  it("clears in-memory conflict events for one app", async () => {
    const appId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await invalidateWriterConflictPaths(appId, [
      {
        path: "dist/app.js",
        expectedParentHash: "aaa",
        actualBlobOid: "bbb",
      },
    ]);

    expect(listRecentWriterConflicts(appId)).toHaveLength(1);
    expect(clearWriterConflictsForApp(appId)).toBe(1);
    expect(listRecentWriterConflicts(appId)).toHaveLength(0);
  });
});
