import { expect, it, vi } from "vitest";
import { createCoalescedRefresh } from "../ui/utils/coalescedRefresh";

it("bounds a slow refresh to one active read and the latest follow-up", async () => {
  const queue = createCoalescedRefresh();
  let release!: () => void;
  const first = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const stale = vi.fn(async () => {});
  const latest = vi.fn(async () => {});
  const done = queue.run(first);
  await Promise.resolve();
  for (let i = 0; i < 100; i++) queue.run(stale);
  queue.run(latest);
  expect(first).toHaveBeenCalledTimes(1);
  expect(latest).not.toHaveBeenCalled();
  release();
  await done;
  expect(stale).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
});

it("discards queued refreshes on teardown and accepts a new scope", async () => {
  const queue = createCoalescedRefresh();
  let release!: () => void;
  const done = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const stale = vi.fn(async () => {});
  queue.run(stale);
  queue.clear();
  const fresh = vi.fn(async () => {});
  queue.run(fresh);
  release();
  await done;
  expect(stale).not.toHaveBeenCalled();
  expect(fresh).toHaveBeenCalledTimes(1);
});
