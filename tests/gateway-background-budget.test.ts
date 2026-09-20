import { afterEach, expect, test, vi } from "vitest";
import { BackgroundBudget } from "../src/gateway/services/gatewayBackgroundBudget.js";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
afterEach(() => vi.useRealTimers());
test("shares capacity across jobs and maintenance and releases on failure", async () => {
  const budget = new BackgroundBudget(() => 1, () => false);
  const hold = deferred(); const started: string[] = [];
  const first = budget.run("job", async () => { started.push("job"); await hold.promise; });
  const second = budget.run("sync", async () => { started.push("sync"); throw new Error("failed"); });
  const failed = expect(second).rejects.toThrow("failed");
  await Promise.resolve(); expect(started).toEqual(["job"]);
  expect(budget.stats().queued).toHaveLength(1);
  hold.resolve(); await first; await failed;
  await budget.run("next", async () => started.push("next"));
  expect(started).toEqual(["job", "sync", "next"]);
  expect(budget.stats().active).toEqual([]);
});
test("prioritizes chats, then admits only one background task after grace", async () => {
  vi.useFakeTimers(); let busy = true;
  const budget = new BackgroundBudget(() => 4, () => busy, () => 1000);
  const hold = deferred(); const work = vi.fn(() => hold.promise);
  const a = budget.run("a", work); const b = budget.run("b", work);
  await vi.advanceTimersByTimeAsync(900); expect(work).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100); expect(work).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000); expect(work).toHaveBeenCalledTimes(1);
  busy = false; await vi.advanceTimersByTimeAsync(100); expect(work).toHaveBeenCalledTimes(2);
  hold.resolve(); await Promise.all([a,b]);
});
test("cancelled queued work never starts and nested work cannot deadlock", async () => {
  const budget = new BackgroundBudget(() => 1, () => false);
  const hold = deferred(); const controller = new AbortController(); const work = vi.fn(async () => {});
  const first = budget.run("parent", async () => { await budget.run("nested", async () => {}); await hold.promise; });
  const queued = budget.run("queued", work, controller.signal);
  const cancelled = expect(queued).rejects.toThrow("cancelled"); controller.abort(); await cancelled;
  hold.resolve(); await first; expect(work).not.toHaveBeenCalled();
  expect(budget.stats().queued).toEqual([]);
});

test("diagnostics distinguish queue wait from work and retain failure outcome", async () => {
  const { getPerformanceDiagnostics, resetPerformanceDiagnosticsForTests } = await import("../src/core/utils/performanceDiagnostics.js");
  resetPerformanceDiagnosticsForTests();
  const budget = new BackgroundBudget(() => 1, () => false);
  const hold = deferred();
  const first = budget.run("held", () => hold.promise);
  const second = budget.run("waiting", async () => { throw new Error("SECRET"); });
  const failure = expect(second).rejects.toThrow("SECRET");
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(getPerformanceDiagnostics().active.find(op => op.name === "waiting")?.status).toBe("queued");
  hold.resolve(); await first; await failure;
  const record = getPerformanceDiagnostics().recent.find(op => op.name === "waiting")!;
  expect(record.queueMs).toBeGreaterThanOrEqual(5);
  expect(record.durationMs).toBeGreaterThanOrEqual(0);
  expect(record.status).toBe("error");
  expect(JSON.stringify(record)).not.toContain("SECRET");
  resetPerformanceDiagnosticsForTests();
});

test("stats name blockers and grace vs capacity", async () => {
  vi.useFakeTimers();
  let busy = false;
  const budget = new BackgroundBudget(() => 1, () => busy, () => 1000);
  const hold = deferred();
  void budget.run("active-job", () => hold.promise);
  await Promise.resolve();
  busy = true;
  void budget.run("waiting-task", async () => {});
  await Promise.resolve();
  let stats = budget.stats();
  expect(stats.queued).toHaveLength(1);
  expect(stats.queued[0]?.label).toBe("waiting-task");
  expect(stats.queued[0]?.blockReason).toBe("grace_period");
  expect(stats.queued[0]?.blockingActive).toContain("active-job");
  await vi.advanceTimersByTimeAsync(1000);
  stats = budget.stats();
  expect(stats.queued[0]?.blockReason).toBe("interactive_busy");
  busy = false;
  hold.resolve();
  await vi.runAllTimersAsync();
});


test("explicit jobs bypass grace behind maintenance but still respect capacity", async () => {
  vi.useFakeTimers();
  const budget = new BackgroundBudget(() => 4, () => true, () => 120000);
  const maintenance = vi.fn(async () => {});
  const background = budget.run("maintenance", maintenance);
  const hold = deferred();
  const firstStarted = vi.fn(() => hold.promise);
  const secondStarted = vi.fn(async () => {});
  const first = budget.runInteractive(() => budget.run("requested-job", firstStarted));
  const second = budget.runInteractive(() => budget.run("second-requested-job", secondStarted));
  await vi.advanceTimersByTimeAsync(0);
  expect(firstStarted).toHaveBeenCalledOnce();
  expect(secondStarted).not.toHaveBeenCalled();
  expect(maintenance).not.toHaveBeenCalled();
  expect(budget.stats().queued.find(w => w.label === "second-requested-job")?.blockReason).toBe("interactive_busy");
  hold.resolve(); await first; await second;
  expect(secondStarted).toHaveBeenCalledOnce();
  expect(maintenance).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(120000); await background;
  expect(maintenance).toHaveBeenCalledOnce();
});

test("interactive admission propagates to awaited dependencies and never leaks to maintenance", async () => {
  vi.useFakeTimers();
  const budget = new BackgroundBudget(() => 1, () => true, () => 1000);
  const started: string[] = [];
  await budget.runInteractive(async () => {
    await budget.run("dependency", async () => { started.push("dependency"); });
    await budget.run("job", async () => {
      await budget.run("nested", async () => { started.push("nested"); });
      started.push("job");
    });
  });
  const background = budget.run("maintenance", async () => { started.push("maintenance"); });
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toEqual(["dependency", "nested", "job"]);
  await vi.advanceTimersByTimeAsync(1000); await background;
  expect(started).toEqual(["dependency", "nested", "job", "maintenance"]);
});

test("cancelled interactive waiters do not run and aged maintenance is not starved", async () => {
  vi.useFakeTimers();
  const budget = new BackgroundBudget(() => 1, () => true, () => 1000);
  const hold = deferred();
  const first = budget.runInteractive(() => budget.run("held", () => hold.promise));
  const order: string[] = [];
  const maintenance = budget.run("maintenance", async () => { order.push("maintenance"); });
  const controller = new AbortController();
  const cancelledWork = vi.fn(async () => {});
  const cancelled = budget.runInteractive(() => budget.run("cancelled", cancelledWork, controller.signal));
  const rejected = expect(cancelled).rejects.toThrow("cancelled");
  controller.abort(); await rejected;
  await vi.advanceTimersByTimeAsync(1000);
  const next = budget.runInteractive(() => budget.run("new-request", async () => { order.push("new-request"); }));
  hold.resolve(); await Promise.all([first, maintenance, next]);
  expect(order).toEqual(["maintenance", "new-request"]);
  expect(cancelledWork).not.toHaveBeenCalled();
});
