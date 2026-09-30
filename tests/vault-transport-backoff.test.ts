import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/core/utils/cloudReposScope.js", () => ({ buildCloudVaultRequestBody: () => ({ keys: [] }) }));
vi.mock("../src/core/utils/paprQuota.js", () => ({ isPaprSubscriptionBlockedMessage: () => false, reportPaprQuotaError: vi.fn() }));
import { pushVaultEntriesViaGatewayHttp } from "../src/gateway/services/vaultSyncBackgroundPush.js";
import { isVaultSyncPlatformPaused, resetVaultSyncPlatformBackoffForTests } from "../src/gateway/services/vaultSyncPlatformBackoff.js";
const entries = [{ name: "test-key", value: "test-value" }];
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetVaultSyncPlatformBackoffForTests(); });
it("a timeout opens the circuit and the next upload does not reach HTTP", async () => {
  vi.useFakeTimers(); vi.stubEnv("VAULT_PUSH_TIMEOUT_MS", "5000");
  vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })));
  const failed = pushVaultEntriesViaGatewayHttp(18789, entries).catch(e => e);
  await vi.advanceTimersByTimeAsync(5001); expect((await failed).name).toBe("AbortError"); expect(isVaultSyncPlatformPaused()).toBe(true);
  await expect(pushVaultEntriesViaGatewayHttp(18789, entries)).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
});
it("workspace cancellation does not blame the platform or trigger cooldown", async () => {
  const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); }));
  await expect(pushVaultEntriesViaGatewayHttp(18789, entries, controller.signal)).rejects.toThrow(); expect(isVaultSyncPlatformPaused()).toBe(false);
});
