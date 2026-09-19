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
