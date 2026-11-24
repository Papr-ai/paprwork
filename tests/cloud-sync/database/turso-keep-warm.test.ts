import { describe, expect, it, vi } from "vitest";
import { TursoDbAdapter } from "../../../src/gateway/services/appRuntime/TursoDbAdapter.js";

describe("TursoDbAdapter keep-warm", () => {
  it("pings recently used clients only", () => {
    vi.useFakeTimers();
    const a = new TursoDbAdapter({} as any) as any;
    const recent = { execute: vi.fn(async () => ({})) };
    const stale = { execute: vi.fn(async () => ({})) };
    a.clientCache.set("r", { client: recent, tokenExpiresAt: Date.now() + 1e6 });
    a.clientCache.set("s", { client: stale, tokenExpiresAt: Date.now() + 1e6 });
    a.clientLastUsed.set(stale, Date.now() - 11 * 60_000);
    a.touchClient(recent);
    vi.advanceTimersByTime(4_100);
    expect(recent.execute).toHaveBeenCalledWith("SELECT 1");
    expect(stale.execute).not.toHaveBeenCalled();
    clearInterval(a.keepWarmTimer);
    vi.useRealTimers();
  });

  it("records last use and last ping for write timing diagnostics", async () => {
    vi.useFakeTimers();
    const a = new TursoDbAdapter({} as any) as any;
    const c = { execute: vi.fn(async () => ({})) };
    a.clientCache.set("c", { client: c, tokenExpiresAt: Date.now() + 1e6 });
    a.touchClient(c);
    const firstUse = Date.now();
    vi.advanceTimersByTime(4_100);
    await Promise.resolve();
    await Promise.resolve();
    expect(a.clientLastPing.get(c)).toBeGreaterThanOrEqual(firstUse + 4_000);
    a.touchClient(c);
    expect(a.clientPrevUse.get(c)).toBe(firstUse);
    clearInterval(a.keepWarmTimer);
    vi.useRealTimers();
  });
});
