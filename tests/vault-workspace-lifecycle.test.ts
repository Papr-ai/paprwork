import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  push: vi.fn(), mark: vi.fn(), mirror: vi.fn(), reconcile: vi.fn(), schedule: vi.fn(),
  keys: [{ name: "test-key", scope: "organization", vaultAudience: "user" }],
}));
vi.mock("../src/gateway/services/CustomKeysService.js", () => ({ getCustomKeysService: () => ({
  listKeys: async () => mocks.keys, getKeyByName: async () => "test-value",
  syncSharedMirrors: mocks.mirror, reconcileShareSyncResult: mocks.reconcile,
}) }));
vi.mock("../src/gateway/services/vaultSyncBackgroundPush.js", () => ({ pushVaultEntriesViaGatewayHttp: mocks.push }));
vi.mock("../src/gateway/utils/vaultPushStateStore.js", () => ({
  filterVaultEntriesNeedingPush: (entries: unknown[]) => ({ toPush: entries, skippedNames: [] }),
  markVaultPushFingerprints: mocks.mark,
}));
vi.mock("../src/gateway/utils/keyResolver.js", () => ({ getPaprApiKey: async () => "test-auth" }));
vi.mock("../src/gateway/services/cloudAgentGateway/resolveCloudProviderAuth.js", () => ({ resolveVaultKeySource: () => "manual" }));
vi.mock("../src/gateway/utils/cloudActingUser.js", () => ({ mergeCloudActingUserBody: (body: unknown) => body }));
vi.mock("../src/core/utils/cloudReposScope.js", () => ({
  resolveActiveNamespaceId: () => "test-namespace", buildCloudVaultRequestBody: () => ({ scope: "user" }),
  mapCustomKeyMetadataToVaultEntry: ({ meta, value }: any) => ({ name: meta.name, value }),
}));
vi.mock("../src/core/utils/paprQuota.js", () => ({ isPaprCloudPaused: () => false, isPaprSubscriptionBlockedMessage: () => false, reportPaprQuotaError: vi.fn() }));
vi.mock("../src/gateway/services/gatewayReadiness.js", () => ({ waitForGatewayRoutesReady: async () => true }));
vi.mock("../src/gateway/services/gatewayBackgroundWork.js", () => ({ yieldToInteractiveHotPath: async () => {}, scheduleCoalescedBackgroundWork: mocks.schedule }));
import { VaultSyncService } from "../src/gateway/services/VaultSyncService.js";
const result = { synced: 1, created: [], updated: ["test-key"], deleted: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.push.mockResolvedValue(result); mocks.mirror.mockResolvedValue({ upserted: 0, pruned: 0 }); mocks.reconcile.mockResolvedValue({});
  mocks.schedule.mockImplementation((_name, run) => { void run(); });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [] }) }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("vault workspace lifecycle", () => {
  it("shares overlapping full syncs without scheduling a second upload", async () => {
    const pending = deferred<typeof result>(); mocks.push.mockReturnValue(pending.promise);
    const service = new VaultSyncService(); const a = service.runFullSync(); const b = service.runFullSync();
    await flush(); expect(mocks.push).toHaveBeenCalledTimes(1);
    pending.resolve(result); await Promise.all([a, b]); await flush();
    expect(mocks.push).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("a real edit during upload schedules a later push without extending the first caller", async () => {
    vi.useFakeTimers(); const pending = deferred<typeof result>(); mocks.push.mockReturnValueOnce(pending.promise);
    const service = new VaultSyncService(); const first = service.pushAllKeys(); await flush();
    service.schedulePushAfterKeyChange("test-key", "changed");
    pending.resolve(result); await first; expect(mocks.push).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); expect(mocks.push).toHaveBeenCalledTimes(2);
  });
  it("aborts outgoing requests and discards late results, then syncs the new workspace", async () => {
    const pending = deferred<typeof result>(); mocks.push.mockReturnValueOnce(pending.promise);
    const service = new VaultSyncService(); const old = service.runFullSync(); await flush();
    const signal = mocks.push.mock.calls[0][2] as AbortSignal;
    await service.beginWorkspaceSwitch(); expect(signal.aborted).toBe(true);
    pending.resolve(result); await old;
    expect(mocks.mark).not.toHaveBeenCalled(); expect(mocks.reconcile).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    await service.runFullSync(); expect(mocks.push).toHaveBeenCalledTimes(1);
    service.syncForWorkspaceSwitch(); await flush(); expect(mocks.push).toHaveBeenCalledTimes(2);
  });
  it("cancels debounced uploads when a workspace switch begins", async () => {
    vi.useFakeTimers(); const service = new VaultSyncService();
    service.scheduleDebouncedPushAll(); await service.beginWorkspaceSwitch();
    await vi.advanceTimersByTimeAsync(5000); expect(mocks.push).not.toHaveBeenCalled();
  });
  it("does not apply shared keys arriving after a workspace switch", async () => {
    const pending = deferred<unknown>(); vi.mocked(fetch).mockReturnValue(pending.promise as Promise<Response>);
    const service = new VaultSyncService(); const pull = service.pullSharedKeys(); await flush();
    await service.beginWorkspaceSwitch(); pending.resolve({ ok: true, json: async () => ({ keys: [{ name: "old-key", value: "old-value", shareScope: "org" }] }) });
    expect(await pull).toBe(0); expect(mocks.mirror).not.toHaveBeenCalled();
  });
  it("waits for an already dispatched keychain write before allowing the pointer to change", async () => {
    const pending = deferred<{ upserted: number; pruned: number }>(); mocks.mirror.mockReturnValue(pending.promise);
    const service = new VaultSyncService(); const pull = service.pullSharedKeys(); await flush(); expect(mocks.mirror).toHaveBeenCalledTimes(1);
    let done = false; const switching = service.beginWorkspaceSwitch().then(() => { done = true; }); await flush(); expect(done).toBe(false);
    pending.resolve({ upserted: 0, pruned: 0 }); await Promise.all([switching, pull]); expect(done).toBe(true);
  });
});
