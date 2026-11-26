/**
 * Design-doc regression test 7 (audit A2): a copy with stale local sync state
 * (any pending upload defers the namespace pull) still settles proposal holds
 * and still asks the web for updates on every 5-minute tick.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const settle = vi.fn(async () => []);
const stale = vi.fn();
vi.mock("../../../src/gateway/services/tursoReplica/settleProposalHolds.js", () => ({ settleProposalHolds: settle }));
vi.mock("../../../src/gateway/services/cloudSync/cloudSyncBroadcast.js", () => ({ notifyCloudSyncItemsStale: stale }));

const { startPeriodicPull } = await import("../../../src/gateway/services/cloudSync/cloudSyncHeartbeat.js");

function host(defer: boolean) {
  let tick: (() => Promise<void>) | null = null;
  const h = {
    sync: {} as never,
    isSyncing: () => false,
    getSyncStatus: () => "idle" as const,
    getPullBackoffUntilMs: () => 0,
    shouldDeferGitPull: async () => ({ defer, reason: defer ? "apps/x has unpublished changes" : undefined }),
    tryAutoReconcileRemoteGit: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
    maybeRunRepoHygiene: vi.fn(async () => undefined),
    setPullTimer: (cb: () => void) => { tick = cb as () => Promise<void>; },
    getHeartbeatTimer: () => null,
    setHeartbeatTimer: () => undefined,
    handleSyncIndexReconcile: async () => undefined,
    handleTrackPullOnPublish: async () => undefined,
  };
  startPeriodicPull(h);
  return { h, tick: () => tick!() };
}

describe("5-minute tick (design test 7)", () => {
  beforeEach(() => { settle.mockClear(); stale.mockClear(); });

  it("pending upload defers the git pull but still settles holds and asks the web", async () => {
    const { h, tick } = host(true);
    await tick();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(stale).toHaveBeenCalled();
    expect(h.pull).not.toHaveBeenCalled();
  });

  it("nothing pending: settles, pulls", async () => {
    const { h, tick } = host(false);
    await tick();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(h.pull).toHaveBeenCalledTimes(1);
  });
});
