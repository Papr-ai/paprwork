import { afterEach, expect, test, vi } from "vitest";
import { JobsService } from "../src/gateway/services/JobsService.js";
import { gatewayBackgroundBudget } from "../src/gateway/services/gatewayBackgroundBudget.js";

vi.mock("../src/gateway/services/gatewayBackgroundBudget.js", async (original) => {
  const mod = await original<typeof import("../src/gateway/services/gatewayBackgroundBudget.js")>();
  return { ...mod, gatewayBackgroundBudget: new mod.BackgroundBudget(() => 1, () => true, () => 120000) };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function makeService() {
  const service = new JobsService();
  const internals = service as any;
  internals.jobs.set("test", { id: "test", name: "Admission test", type: "bash", status: "pending", command: "true" });
  vi.spyOn(internals, "validateJobCandidate").mockResolvedValue([]);
  vi.spyOn(internals, "ensureDependencyChain").mockResolvedValue(undefined);
  vi.spyOn(internals, "appendLog").mockResolvedValue(undefined);
  vi.spyOn(internals, "getJob").mockImplementation(async (id: string) => internals.jobs.get(id));
  vi.spyOn(internals, "setJobStatus").mockImplementation(async (id: string, status: string, patch: object) => {
    const job = { ...internals.jobs.get(id), ...patch, status };
    internals.jobs.set(id, job); return job;
  });
  return { service, internals };
}

test("queued jobs remain pending and cancellation never launches their executor", async () => {
  vi.useFakeTimers();
  const { service, internals } = makeService();
  const executor = vi.spyOn(internals, "runSingleAttempt");
  const run = service.runJob("test");
  await vi.advanceTimersByTimeAsync(0);
  expect(internals.jobs.get("test").status).toBe("pending");
  expect(gatewayBackgroundBudget.stats().queued).toHaveLength(1);
  expect(executor).not.toHaveBeenCalled();
  await service.stopJob("test");
  expect((await run).status).toBe("cancelled");
  expect(executor).not.toHaveBeenCalled();
  expect(gatewayBackgroundBudget.stats().queued).toEqual([]);
});

test("an explicitly requested job reaches running before execution without grace delay", async () => {
  vi.useFakeTimers();
  const { service, internals } = makeService();
  const executor = vi.spyOn(internals, "runSingleAttempt").mockImplementation(async () => {
    expect(internals.jobs.get("test").status).toBe("running");
    // End without invoking unrelated completion telemetry or persistence.
    internals.jobs.set("test", { ...internals.jobs.get("test"), status: "cancelled" });
    return { exitCode: 0 };
  });
  const run = gatewayBackgroundBudget.runInteractive(() => service.runJob("test"));
  await vi.advanceTimersByTimeAsync(0);
  await run;
  expect(executor).toHaveBeenCalledOnce();
  expect(gatewayBackgroundBudget.stats().active).toEqual([]);
});
