/**
 * A published app showed "Draft" after switching org: the publish-status cache
 * kept a 404 from the old org's key for 1h. Entries now belong to the key that
 * fetched them, and a switch clears the cache.
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloudApiFetch = vi.fn();
vi.mock("../../../src/gateway/utils/cloudApiClient.js", () => ({ cloudApiFetch }));

const { CloudAppPublishService, invalidatePublishStatusCache } = await import(
  "../../../src/gateway/services/CloudAppPublishService.js"
);

const live = { app_id: "app-1", slug: "demo", enabled: true, share_url: "https://apps.papr.ai/ns/demo" };
const notFound = () => new Response("Not Found", { status: 404 });
const found = () => new Response(JSON.stringify(live), { status: 200 });

type Fetch = (appId: string) => Promise<unknown>;
function lookup(): Fetch {
  const svc = new CloudAppPublishService(path.join(os.tmpdir(), "pw-publish-cache-test"));
  return (appId) => (svc as unknown as { fetchMemoryPublishResponse: Fetch }).fetchMemoryPublishResponse(appId);
}

describe("publish status cache across orgs", () => {
  const savedKey = process.env.PAPR_API_KEY;
  beforeEach(() => {
    vi.clearAllMocks();
    invalidatePublishStatusCache();
  });
  afterEach(() => {
    process.env.PAPR_API_KEY = savedKey;
  });

  it("a 404 under org A's key is not reused once org B's key is active", async () => {
    const get = lookup();
    process.env.PAPR_API_KEY = "key-org-a";
    cloudApiFetch.mockResolvedValueOnce(notFound());
    expect(await get("app-1")).toBeNull();

    process.env.PAPR_API_KEY = "key-org-b";
    cloudApiFetch.mockResolvedValueOnce(found());
    expect(await get("app-1")).toMatchObject({ slug: "demo", enabled: true });
    expect(cloudApiFetch).toHaveBeenCalledTimes(2);
  });

  it("still caches a 404 under the same key (no extra requests)", async () => {
    const get = lookup();
    process.env.PAPR_API_KEY = "key-org-a";
    cloudApiFetch.mockResolvedValue(notFound());
    await get("app-1");
    await get("app-1");
    expect(cloudApiFetch).toHaveBeenCalledTimes(1);
  });

  it("invalidatePublishStatusCache() forces a fresh read", async () => {
    const get = lookup();
    process.env.PAPR_API_KEY = "key-org-a";
    cloudApiFetch.mockResolvedValueOnce(notFound());
    await get("app-1");
    invalidatePublishStatusCache();
    cloudApiFetch.mockResolvedValueOnce(found());
    expect(await get("app-1")).toMatchObject({ enabled: true });
  });
});
