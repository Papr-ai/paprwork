import { beforeEach, describe, expect, it, vi } from "vitest";

const acked: Array<{ path: string; blobOid: string }> = [];
const invalidated: string[] = [];
const forgotten: string[] = [];
vi.mock("../src/gateway/services/syncV3/OidCache.js", () => ({
  removeCachedPaths: vi.fn(async (_a: string, paths: string[]) => {
    forgotten.push(...paths);
  }),
  applyAckedBlobOids: vi.fn(async (_a: string, files: Array<{ path: string; blobOid: string }>) => {
    acked.push(...files);
  }),
  seedOidCacheFromHead: vi.fn(),
}));
vi.mock("../src/gateway/services/syncV3/writerConflict.js", () => ({
  invalidateWriterConflictPaths: vi.fn(async (_a: string, arts: Array<{ path: string }>) => {
    invalidated.push(...arts.map((x) => x.path));
  }),
}));
vi.mock("../src/gateway/services/syncV3/writerConfig.js", () => ({
  getAppRepoWriterBaseUrl: () => "http://writer.test",
  isLocalAppRepoWriter: () => true,
}));
vi.mock("../src/gateway/utils/keyResolver.js", () => ({ getPaprApiKey: async () => "k" }));
vi.mock("../src/gateway/services/syncV3/appRepoCommittedFanout.js", () => ({
  writeAppRepoCommitCursor: vi.fn(),
}));
vi.mock("../src/gateway/services/syncV3/appRepoHeadSyncCheck.js", () => ({
  realignLocalAppCodeBaseline: vi.fn(),
}));

import { computeBlobOidForContent } from "../src/gateway/services/syncV3/computeParentHash.js";
import { AppOpsConflictError, postAppOps } from "../src/gateway/services/syncV3/AppOpsClient.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("postAppOps 409 where cloud already has our bytes", () => {
  beforeEach(() => {
    acked.length = 0;
    invalidated.length = 0;
  });

  it("adopts cloud OIDs and sends only the rest (lost-ack after restart)", async () => {
    const same = "same bytes";
    const sameOid = await computeBlobOidForContent(same);
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) {
        return json(409, {
          conflict: true,
          artifacts: [{ path: "backend/bundle.json", expectedParentHash: "stale", actualBlobOid: sameOid }],
        });
      }
      return json(200, { commitSha: "c2", files: [{ path: "index.html", blobOid: "o2" }] });
    }));

    const ack = await postAppOps("app-1", {
      files: [
        { path: "backend/bundle.json", content: same, parentHash: "stale" },
        { path: "index.html", content: "new", parentHash: "p" },
      ],
      author: "a",
      message: "m",
      idempotencyKey: "k1",
    });

    expect(ack.commitSha).toBe("c2");
    expect(calls[1].files.map((f: any) => f.path)).toEqual(["index.html"]);
    expect(acked).toContainEqual({ path: "backend/bundle.json", blobOid: sameOid });
    expect(invalidated).toEqual([]); // not recorded as a conflict
  });

  it("a delete the cloud already applied is forgotten, not re-sent", async () => {
    const calls: any[] = [];
    forgotten.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      // Nothing left to send, so the client asks for cloud HEAD instead.
      if (!init?.body) return json(200, { commitSha: "c1", files: [] });
      calls.push(JSON.parse(init.body));
      return json(409, {
        conflict: true,
        artifacts: [{ path: "old.ts", expectedParentHash: "stale", actualBlobOid: null }],
      });
    }));

    const ack = await postAppOps("app-1", {
      files: [{ path: "old.ts", content: null, parentHash: "stale" }],
      author: "a",
      message: "m",
      idempotencyKey: "k-del",
    });

    expect(calls).toHaveLength(1); // nothing left to send
    expect(ack.files).toEqual([]);
    expect(forgotten).toEqual(["old.ts"]);
  });

  it("still raises a real conflict when cloud holds different bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      json(409, {
        conflict: true,
        artifacts: [{ path: "index.html", expectedParentHash: "p", actualBlobOid: "someone-else" }],
      }),
    ));
    await expect(
      postAppOps("app-1", {
        files: [{ path: "index.html", content: "mine", parentHash: "p" }],
        author: "a",
        message: "m",
        idempotencyKey: "k2",
      }),
    ).rejects.toBeInstanceOf(AppOpsConflictError);
    expect(invalidated).toEqual(["index.html"]);
  });
});
