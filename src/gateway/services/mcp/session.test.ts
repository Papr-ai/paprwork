import { describe, expect, it, vi } from "vitest";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { memorySessionExchange } from "./session.js";
import { memoryHandoff, HandoffError } from "./handoff.js";

const NOW = 1_800_000_000_000;
const ok = (over: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      userId: "u1",
      email: "a@acme.com",
      sessionToken: "r:mcp",
      sessionExpiresAt: new Date(NOW + 3600_000).toISOString(),
      organizationId: "o1",
      namespaceId: "n1",
      workspaceId: "w1",
      provisioned: ["workspace"],
      ...over,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const err = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ detail: { code, message: `m:${code}` } }), { status, headers });

function setup(responses: Array<Response | Error>) {
  const fetchImpl = vi.fn(async () => {
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return r;
  });
  const sleep = vi.fn(async () => {});
  let now = NOW;
  const exchange = memorySessionExchange("https://memory.test/", "svc", {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => now,
    sleep,
  });
  return { exchange, fetchImpl, sleep, advance: (ms: number) => (now += ms) };
}

describe("memorySessionExchange", () => {
  it("posts the Claude token with the service key and maps the tenant", async () => {
    const { exchange, fetchImpl } = setup([ok()]);
    const caller = await exchange("tok", NOW / 1000 + 600);
    expect(caller).toMatchObject({ sessionToken: "r:mcp", userId: "u1", organizationId: "o1", namespaceId: "n1", provisioned: ["workspace"] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://memory.test/v1/cloud/mcp/session");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok", "x-papr-service-key": "svc" });
  });

  it("caches per token until the token expires, and de-duplicates bursts", async () => {
    const { exchange, fetchImpl, advance } = setup([ok(), ok({ userId: "u2" })]);
    const [a, b] = await Promise.all([exchange("tok", NOW / 1000 + 120), exchange("tok", NOW / 1000 + 120)]);
    expect(a.userId).toBe("u1");
    expect(b.userId).toBe("u1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(119_000);
    expect((await exchange("tok", NOW / 1000 + 120)).userId).toBe("u1");
    advance(2_000);
    expect((await exchange("tok", NOW / 1000 + 120)).userId).toBe("u2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never caches past the Papr session's expiry", async () => {
    const { exchange, fetchImpl } = setup([ok({ sessionExpiresAt: new Date(NOW + 30_000).toISOString() }), ok()]);
    await exchange("tok", NOW / 1000 + 600);
    await exchange("tok", NOW / 1000 + 600);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("401 and account_not_ready → InvalidTokenError (Claude re-runs sign-in)", async () => {
    await expect(setup([err(401, "invalid_token")]).exchange("t")).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(setup([err(403, "account_not_ready")]).exchange("t")).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("waits out first-run setup, then succeeds", async () => {
    const { exchange, sleep } = setup([err(409, "setup_in_progress", { "retry-after": "3" }), ok()]);
    expect((await exchange("t")).userId).toBe("u1");
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("gives up on setup after two retries with a friendly ServerError", async () => {
    const busy = () => err(409, "setup_in_progress");
    const { exchange, fetchImpl } = setup([busy(), busy(), busy()]);
    await expect(exchange("t")).rejects.toThrow(/still setting up/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("deferred, misconfigured, network and 5xx → ServerError, not cached", async () => {
    for (const r of [err(409, "setup_deferred"), err(403, "forbidden"), err(503, "mcp_not_configured"), err(502, "setup_failed"), new Error("ECONNRESET")]) {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(setup([r]).exchange("t")).rejects.toBeInstanceOf(ServerError);
      spy.mockRestore();
    }
    const { exchange, fetchImpl } = setup([err(502, "setup_failed"), ok()]);
    await expect(exchange("t")).rejects.toBeInstanceOf(ServerError);
    expect((await exchange("t")).userId).toBe("u1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("memoryHandoff", () => {
  const caller = { sessionToken: "r:mcp", userId: "u1", subject: "s" };
  it("asks memory for a papr:// link as the caller", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "c", url: "papr://auth/handoff?code=c", expiresAt: "2027-01-01T00:00:00Z" })));
    const link = await memoryHandoff("https://memory.test", fetchImpl as unknown as typeof fetch)(caller, { appNamespaceId: "n", appSlug: "s" });
    expect(link.url).toBe("papr://auth/handoff?code=c");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://memory.test/v1/cloud/handoff/codes");
    expect(init.headers).toMatchObject({ "X-Session-Token": "r:mcp" });
    expect(JSON.parse(String(init.body))).toEqual({ appNamespaceId: "n", appSlug: "s", source: "claude" });
  });
  it("rejects non-papr links and maps rate limits", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ url: "https://evil.example" })));
    await expect(memoryHandoff("m", bad as unknown as typeof fetch)(caller, {})).rejects.toBeInstanceOf(HandoffError);
    const limited = vi.fn(async () => new Response("{}", { status: 429 }));
    await expect(memoryHandoff("m", limited as unknown as typeof fetch)(caller, {})).rejects.toThrow(/Too many/);
  });
});
