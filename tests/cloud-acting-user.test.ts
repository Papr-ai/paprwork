import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/utils/paprUserId.js", () => ({
  getPaprUserId: vi.fn(() => "WkPutXGdqg"),
}));

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getPaprApiKey: vi.fn(async () => "sk-test-key"),
}));

describe("cloudActingUser", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("mergeCloudActingUserBody adds external_user_id", async () => {
    const { mergeCloudActingUserBody } = await import(
      "../src/gateway/utils/cloudActingUser.js"
    );
    expect(
      mergeCloudActingUserBody({ database: "j-de1a89d8" }),
    ).toEqual({
      database: "j-de1a89d8",
      external_user_id: "WkPutXGdqg",
    });
  });

  it("appendCloudActingUserQuery adds query param", async () => {
    const { appendCloudActingUserQuery } = await import(
      "../src/gateway/utils/cloudActingUser.js"
    );
    expect(
      appendCloudActingUserQuery("/v1/cloud/apps/team?namespaceId=ns1"),
    ).toBe(
      "/v1/cloud/apps/team?namespaceId=ns1&external_user_id=WkPutXGdqg",
    );
  });

  it("cloudApiFetch merges acting user into POST body", async () => {
    const fetchMock = vi.mocked(global.fetch);
    const { cloudApiFetch } = await import("../src/gateway/utils/cloudApiClient.js");

    await cloudApiFetch("/v1/cloud/apps/publish", {
      method: "POST",
      body: { appId: "abc", slug: "demo" },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      appId: "abc",
      slug: "demo",
      external_user_id: "WkPutXGdqg",
    });
  });

  it("cloudApiFetch appends acting user on GET", async () => {
    const fetchMock = vi.mocked(global.fetch);
    const { cloudApiFetch } = await import("../src/gateway/utils/cloudApiClient.js");

    await cloudApiFetch("/v1/cloud/apps/team?namespaceId=ns1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("external_user_id=WkPutXGdqg");
  });

  it("cloudApiFetch appends acting user on DELETE without body", async () => {
    const fetchMock = vi.mocked(global.fetch);
    const { cloudApiFetch } = await import("../src/gateway/utils/cloudApiClient.js");

    await cloudApiFetch("/v1/cloud/apps/publish/app-1", { method: "DELETE" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("external_user_id=WkPutXGdqg");
  });
});
