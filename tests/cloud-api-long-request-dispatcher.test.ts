import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getPaprApiKey: vi.fn(async () => "test-key"),
}));

describe("cloudApiFetch long-request dispatcher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches an undici dispatcher when timeoutMs exceeds undici's 300s headers timeout", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { cloudApiFetch } = await import("../src/gateway/utils/cloudApiClient.js");

    await cloudApiFetch("/v1/cloud/runtime/job-run", {
      method: "POST",
      body: { jobId: "j" },
      timeoutMs: 630_000,
    });
    const opts = fetchSpy.mock.calls[0][1] as { dispatcher?: { constructor: { name: string } } };
    expect(opts.dispatcher).toBeDefined();
    expect(opts.dispatcher?.constructor.name).toBe("Agent");
  });

  it("leaves short requests on the default dispatcher", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { cloudApiFetch } = await import("../src/gateway/utils/cloudApiClient.js");

    await cloudApiFetch("/v1/cloud/runtime/heartbeat", { method: "POST", body: {}, timeoutMs: 15_000 });
    const opts = fetchSpy.mock.calls[0][1] as { dispatcher?: unknown };
    expect(opts.dispatcher).toBeUndefined();
  });
});
