import { beforeEach, describe, expect, it, vi } from "vitest";

const SLOW_MS = 400;
const fetchMock = vi.fn();

vi.mock("./memoryRuntimeClient.js", () => ({
  getCloudAppHostKey: () => "host-key",
  runtimeFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock("./cloudAppHostCache.js", () => ({ fetchCachedRuntimeRepoFile: async () => null }));
vi.mock("../cloudPublishPrefs.js", () => ({ loadCloudPublishPrefs: () => ({ apps: {} }) }));
vi.mock("./cloudAppHostShareAllowlistPushStore.js", () => ({ getSharePeopleAllowlistPush: () => undefined }));

import {
  invalidateRuntimeShareAllowlistCache,
  loadSharePeopleAllowlistForCloudHost,
} from "./cloudAppSharePeopleAllowlistLoader.js";
import type { AppRuntimeRouteAuth } from "./types.js";

const auth = { namespaceId: "ns-1", slug: "report" } as AppRuntimeRouteAuth;
const slow = (status: number, body: unknown) =>
  new Promise((r) => setTimeout(() => r({ ok: status < 300, status, json: async () => body }), SLOW_MS));
const timed = async () => { const t = Date.now(); const v = await loadSharePeopleAllowlistForCloudHost(auth, "app-1"); return { v, ms: Date.now() - t }; };

describe("runtime share allowlist cache (slow memory server)", () => {
  beforeEach(() => { fetchMock.mockReset(); invalidateRuntimeShareAllowlistCache(); });

  it("team app with no allowlist: first call pays memory latency, repeats are instant", async () => {
    fetchMock.mockImplementation(() => slow(200, {}));
    const first = await timed();
    const rest = [];
    for (let i = 0; i < 20; i++) rest.push(await timed());
    expect(first.v).toBeUndefined();
    expect(first.ms).toBeGreaterThanOrEqual(SLOW_MS - 20);
    expect(Math.max(...rest.map((r) => r.ms))).toBeLessThan(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    console.info(`[timing] first=${first.ms}ms next20 max=${Math.max(...rest.map((r) => r.ms))}ms memoryCalls=${fetchMock.mock.calls.length}`);
  });

  it("caches a real allowlist and concurrent misses share one memory call", async () => {
    fetchMock.mockImplementation(() => slow(200, { allowedUserIds: ["u1"] }));
    const all = await Promise.all(Array.from({ length: 5 }, () => loadSharePeopleAllowlistForCloudHost(auth, "app-1")));
    expect(all[0]?.allowedUserIds ?? (all[0] as any)?.userIds).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures; invalidation forces a refetch", async () => {
    fetchMock.mockImplementation(() => slow(500, {}));
    await loadSharePeopleAllowlistForCloudHost(auth, "app-1");
    await loadSharePeopleAllowlistForCloudHost(auth, "app-1");
    // runtime 500 then publish-record fallback (500 cached 60s by that path) -> 3 calls for 2 lookups
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => slow(200, {}));
    await loadSharePeopleAllowlistForCloudHost(auth, "app-1");
    invalidateRuntimeShareAllowlistCache();
    await loadSharePeopleAllowlistForCloudHost(auth, "app-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
