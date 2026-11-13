import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthCallbackServer } from "./OAuthCallbackServer.js";

let server: OAuthCallbackServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
});

async function start(opts: Partial<ConstructorParameters<typeof OAuthCallbackServer>[0]> = {}) {
  server = new OAuthCallbackServer({ port: 18911, maxPortAttempts: 20, ...opts });
  await server.start();
  return server.getCallbackUrl()!;
}

describe("OAuthCallbackServer", () => {
  it("keeps answering after the callback instead of refusing the connection", async () => {
    const onCallback = vi.fn();
    const url = await start({ keepAliveAfterCallback: true, onCallback, repeatHtml: "ALREADY_USED" });

    const first = await fetch(`${url}?code=abc&state=s1`);
    expect(first.status).toBe(200);
    expect(onCallback).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 1200)); // old behaviour closed after 1s
    const reload = await fetch(`${url}?code=abc&state=s1`);
    expect(await reload.text()).toContain("ALREADY_USED");
    expect(onCallback).toHaveBeenCalledTimes(1); // single-use code not replayed
  });

  it("rejects a callback from a stale attempt without consuming the listener", async () => {
    const onCallback = vi.fn();
    const url = await start({
      keepAliveAfterCallback: true,
      onCallback,
      validateCallback: (p) => (p.get("state") === "current" ? null : { title: "Expired", body: "Try again" }),
    });

    const stale = await fetch(`${url}?code=old&state=previous`);
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain("Expired");
    expect(onCallback).not.toHaveBeenCalled();

    const good = await fetch(`${url}?code=new&state=current`);
    expect(good.status).toBe(200);
    expect(onCallback).toHaveBeenCalledTimes(1);
  });

  it("reports a timeout only when no callback arrived", async () => {
    const onTimeout = vi.fn();
    await start({ timeout: 100, onTimeout });
    await new Promise((r) => setTimeout(r, 250));
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(server!.isRunning()).toBe(false);
  });

  it("settle() lets repeat hits through for a while, then closes", async () => {
    const url = await start({ keepAliveAfterCallback: true, repeatHtml: "DONE" });
    server!.settle(150);
    expect(await (await fetch(`${url}?code=x&state=y`)).text()).toContain("DONE");
    await new Promise((r) => setTimeout(r, 300));
    expect(server!.isRunning()).toBe(false);
  });
});
