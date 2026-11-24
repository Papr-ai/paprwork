import { describe, expect, it, vi, beforeEach } from "vitest";

const refresh = vi.fn();
const syncFromLivePaprChrome = vi.fn();
let statuses: Array<Record<string, unknown>> = [];

vi.mock("../../src/gateway/services/platforms/PlatformSessionService.js", () => ({
  getPlatformSessionService: () => ({
    getAllStatuses: async () => statuses,
    refresh,
    syncFromLivePaprChrome,
  }),
}));

import { SessionKeeperService } from "../../src/gateway/services/platforms/SessionKeeperService.js";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function tick(keeper: SessionKeeperService) {
  (keeper as unknown as { running: boolean }).running = true;
  await (keeper as unknown as { checkAllPlatforms(): Promise<void> }).checkAllPlatforms();
}

describe("SessionKeeperService persistence", () => {
  beforeEach(() => {
    refresh.mockReset();
    syncFromLivePaprChrome.mockReset();
    statuses = [];
  });

  it("does not re-check a non-rotating site refreshed 2h ago", async () => {
    statuses = [{ platformId: "reddit", status: "connected", lastRefreshedAt: hoursAgo(2) }];
    await tick(new SessionKeeperService());
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-checks a non-rotating site after 6h", async () => {
    refresh.mockResolvedValue({ status: "connected" });
    statuses = [{ platformId: "reddit", status: "connected", lastRefreshedAt: hoursAgo(7) }];
    await tick(new SessionKeeperService());
    expect(refresh).toHaveBeenCalledWith("reddit");
  });

  it("treats connected-with-error as a failed check (backoff)", async () => {
    refresh.mockResolvedValue({ status: "connected", error: "ENOSPC" });
    statuses = [{ platformId: "reddit", status: "connected", lastRefreshedAt: hoursAgo(7) }];
    const keeper = new SessionKeeperService();
    await tick(keeper);
    const state = (keeper as unknown as { refreshState: Map<string, { consecutiveFailures: number }> }).refreshState;
    expect(state.get("reddit")?.consecutiveFailures).toBe(1);
  });

  it("tries to recover needs_reauth sites from Papr Chrome", async () => {
    syncFromLivePaprChrome.mockResolvedValue(null);
    statuses = [{ platformId: "reddit", status: "needs_reauth" }];
    await tick(new SessionKeeperService());
    expect(syncFromLivePaprChrome).toHaveBeenCalledWith("reddit");
    expect(refresh).not.toHaveBeenCalled();
  });
});
