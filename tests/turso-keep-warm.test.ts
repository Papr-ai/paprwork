import { describe, expect, it, vi } from "vitest";
import { TursoDbAdapter } from "../src/gateway/services/appRuntime/TursoDbAdapter.js";

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
});
