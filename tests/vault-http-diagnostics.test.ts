import { afterEach, expect, test, vi } from "vitest";
vi.mock("../src/core/utils/cloudReposScope.js", () => ({ buildCloudVaultRequestBody: () => ({ keys: [] }) }));
vi.mock("../src/gateway/services/vaultSyncPlatformBackoff.js", () => ({ isVaultSyncPlatformPaused: () => false, getVaultSyncPlatformPauseReason: () => null, recordVaultSyncPlatformFailure: vi.fn(), recordVaultSyncPlatformSuccess: vi.fn() }));
import { pushVaultEntriesViaGatewayHttp } from "../src/gateway/services/vaultSyncBackgroundPush.js";
import { traceDiagnosticPhase, getPerformanceDiagnostics, resetPerformanceDiagnosticsForTests } from "../src/core/utils/performanceDiagnostics.js";
import { getPaprCloudPauseDiagnostics, isPaprCloudPaused, setPaprCloudPaused } from "../src/core/utils/paprQuota.js";
afterEach(() => { vi.unstubAllGlobals(); setPaprCloudPaused(false); resetPerformanceDiagnosticsForTests(); });
test("subscription failures pause cloud and remain visible as failed HTTP phases", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok:false,status:403,text:async()=>"No active subscription" }));
 const entries = [{name:"private-key",value:"secret-value"}] as Parameters<typeof pushVaultEntriesViaGatewayHttp>[1];
 await traceDiagnosticPhase("vault:push-http",()=>pushVaultEntriesViaGatewayHttp(18789,entries)).catch(()=>{});
 expect(isPaprCloudPaused()).toBe(true);
 expect(getPaprCloudPauseDiagnostics().changedAt).not.toBeNull();
 const record=getPerformanceDiagnostics().recent[0];expect(record.status).toBe("error");expect(record.errorType).toBe("http_403");
 expect(JSON.stringify(record)).not.toMatch(/private-key|secret-value/);
});
