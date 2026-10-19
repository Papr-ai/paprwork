import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./githubWorktree.js", () => ({
  applyAppRepoOps: vi.fn(async () => ({ commitSha: "abc", files: [] })),
  readAppRepoHead: vi.fn(),
}));
vi.mock("./distributedRepoLock.js", () => ({
  withDistributedAppRepoLock: (_a: string, _k: string, fn: () => unknown) => fn(),
  WriterLeaseContentionError: class extends Error {},
}));
vi.mock("./pubsubNotify.js", () => ({ publishAppRepoCommitted: vi.fn(async () => undefined) }));
vi.mock("../../utils/cloudApiClient.js", () => ({ getMemoryServerBaseUrl: () => "http://mem" }));

import { AppRepoWriterService, resetAppRepoRecordCacheForTests } from "./AppRepoWriterService.js";
import { applyAppRepoOps } from "./githubWorktree.js";

const record = (extra: Record<string, unknown>) => ({
  appId: "app-1", namespaceId: "ns", githubOrg: "o", repoName: "r", shardId: "s",
  cloneUrl: "https://github.com/o/r.git", repoUrl: "https://github.com/o/r", createdAt: "2026-01-01",
  ...extra,
});
const body = (key: string) => ({
  idempotencyKey: key, message: "m",
  author: "a", files: [{ path: "index.html", content: "<p>x</p>", parentHash: "" }],
});

describe("AppRepoWriterService role gate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetAppRepoRecordCacheForTests();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(applyAppRepoOps).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  const respond = (rec: unknown) =>
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => rec, text: async () => "" });

  it("refuses a caller below Maintainer with 403 and never touches GitHub", async () => {
    respond(record({ callerCanWriteMain: false, callerRole: "contributor" }));
    const out = await new AppRepoWriterService().postOps("app-1", "key-a", body("k1"));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(403);
      expect(out.body.code).toBe("role_cannot_publish");
      expect(out.body.role).toBe("contributor");
    }
    expect(applyAppRepoOps).not.toHaveBeenCalled();
  });

  it("allows maintainers and older servers that omit the field", async () => {
    respond(record({ callerCanWriteMain: true }));
    expect((await new AppRepoWriterService().postOps("app-1", "key-b", body("k2"))).ok).toBe(true);
    resetAppRepoRecordCacheForTests();
    respond(record({}));
    expect((await new AppRepoWriterService().postOps("app-1", "key-c", body("k3"))).ok).toBe(true);
  });

  it("caches the record per app+key so burst pushes make one memory call", async () => {
    respond(record({ callerCanWriteMain: true }));
    const svc = new AppRepoWriterService();
    await svc.postOps("app-1", "key-d", body("k4"));
    await svc.postOps("app-1", "key-d", body("k5"));
    await svc.postOps("app-1", "key-d", body("k6"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await svc.postOps("app-1", "other-key", body("k7"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("AppRepoWriterService acting user", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetAppRepoRecordCacheForTests();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("forwards the desktop user to memory so an owner on a shared key can publish", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const owner = url.includes("external_user_id=owner-1");
      return {
        ok: true, status: 200, text: async () => "",
        json: async () => record(owner
          ? { callerCanWriteMain: true, callerRole: "admin" }
          : { callerCanWriteMain: false, callerRole: "viewer" }),
      };
    });
    const out = await new AppRepoWriterService().postOps("app-1", "shared-key", body("u1"), "owner-1");
    expect(out.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/repo?external_user_id=owner-1");
  });

  it("caches per user, so two members on one key never share a role", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, text: async () => "",
      json: async () => record({ callerCanWriteMain: true }),
    });
    const svc = new AppRepoWriterService();
    await svc.postOps("app-1", "shared-key", body("u2"), "user-a");
    await svc.postOps("app-1", "shared-key", body("u3"), "user-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("omits the query when no user is known (older desktops)", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, text: async () => "",
      json: async () => record({ callerCanWriteMain: true }),
    });
    await new AppRepoWriterService().postOps("app-1", "k", body("u4"));
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/repo$/);
  });
});
