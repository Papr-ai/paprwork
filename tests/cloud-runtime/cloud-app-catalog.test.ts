import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../src/gateway/utils/cloudApiClient.js", () => ({ cloudApiFetch: (...a: unknown[]) => fetchMock(...a) }));
vi.mock("../../src/gateway/utils/paprUserId.js", () => ({ getPaprUserId: () => "u1" }));

import {
  fetchCloudAccessibleApps,
  isOwnCatalogApp,
  resetCloudAppCatalogCacheForTests,
} from "../../src/gateway/services/cloudAgentGateway/cloudAppCatalog.js";

describe("cloud app catalog for cloud runs", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetCloudAppCatalogCacheForTests();
  });
  afterEach(() => resetCloudAppCatalogCacheForTests());

  it("lists accessible apps once per minute and marks only own apps editable", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ apps: [
      { appId: "a1", name: "Chores", shareUrl: "https://host/NS/chores", publisherUserId: "u1" },
      { appId: "a2", name: "Team CRM", shareUrl: "https://host/NS/crm", publisherUserId: "u2" },
      { name: "no id" },
    ] }), { status: 200 }));
    const apps = await fetchCloudAccessibleApps();
    await fetchCloudAccessibleApps();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/v1/cloud/apps/accessible");
    expect(apps.map((a) => a.appId)).toEqual(["a1", "a2"]);
    expect(isOwnCatalogApp(apps[0])).toBe(true);
    expect(isOwnCatalogApp(apps[1])).toBe(false);
  });

  it("returns [] when the catalog is unavailable and does not cache it", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 503 }));
    expect(await fetchCloudAccessibleApps()).toEqual([]);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ apps: [{ appId: "a1" }] }), { status: 200 }));
    expect((await fetchCloudAccessibleApps()).length).toBe(1);
  });
});
