import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ schedule: vi.fn(), busy: vi.fn(() => false), inFlight: vi.fn(() => false), resumeIndex: vi.fn(), full: vi.fn() }));
vi.mock("../src/gateway/services/CodeIndexingService.js", () => ({ resumeCodeIndexingAfterBillingRestore: mocks.resumeIndex }));
vi.mock("../src/gateway/services/VaultSyncService.js", () => ({ getVaultSyncService: () => ({ isSyncBusy: mocks.busy, runFullSync: mocks.full }) }));
vi.mock("../src/gateway/services/gatewayBackgroundWork.js", () => ({ scheduleCoalescedBackgroundWork: mocks.schedule, isCoalescedBackgroundTaskInFlight: mocks.inFlight }));
import { schedulePaprCloudResumeAfterBillingRestore } from "../src/gateway/services/paprCloudBillingRestore.js";
import { setPaprCloudPaused, isPaprCloudPaused } from "../src/core/utils/paprQuota.js";
beforeEach(() => { vi.clearAllMocks(); setPaprCloudPaused(false); mocks.busy.mockReturnValue(false); });
test("billing and focus refreshes do not start maintenance when already active", () => {
 for(let i=0;i<10;i++)expect(schedulePaprCloudResumeAfterBillingRestore()).toEqual({ resumed: false, scheduled: false });
 expect(mocks.schedule).not.toHaveBeenCalled(); expect(mocks.resumeIndex).not.toHaveBeenCalled();
});
test("a real pause resumes once and schedules the full sync", async () => {
 setPaprCloudPaused(true);
 expect(schedulePaprCloudResumeAfterBillingRestore()).toEqual({ resumed: true, scheduled: true });
 expect(isPaprCloudPaused()).toBe(false);
 schedulePaprCloudResumeAfterBillingRestore();
 expect(mocks.schedule).toHaveBeenCalledTimes(1);
 await mocks.schedule.mock.calls[0][1](); expect(mocks.full).toHaveBeenCalledOnce();
});
test("restoring access shares existing vault activity", () => {
 setPaprCloudPaused(true); mocks.busy.mockReturnValue(true);
 expect(schedulePaprCloudResumeAfterBillingRestore()).toEqual({ resumed: true, scheduled: false });
 expect(mocks.schedule).not.toHaveBeenCalled(); expect(isPaprCloudPaused()).toBe(false);
});
