import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellLoadWatch } from "../ui/utils/miniAppShellProbe";

describe("ShellLoadWatch (announce-vs-load race)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not retry when the bridge announced before the frame's load event", () => {
    // Real order for image-heavy apps: DOMContentLoaded (announce) long before load.
    const w = new ShellLoadWatch(2_000);
    const retry = vi.fn();
    w.begin();
    w.markAnnounced();
    w.awaitAnnouncement(retry);
    vi.advanceTimersByTime(5_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not retry when the announcement lands inside the grace window", () => {
    const w = new ShellLoadWatch(2_000);
    const retry = vi.fn();
    w.begin();
    w.awaitAnnouncement(retry);
    vi.advanceTimersByTime(1_000);
    w.markAnnounced();
    vi.advanceTimersByTime(5_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries once when nothing announces (Express 404 for an unregistered route)", () => {
    const w = new ShellLoadWatch(2_000);
    const retry = vi.fn();
    w.begin();
    w.awaitAnnouncement(retry);
    vi.advanceTimersByTime(2_001);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("forgets the previous load's announcement when a new document begins", () => {
    const w = new ShellLoadWatch(2_000);
    const retry = vi.fn();
    w.begin();
    w.markAnnounced();
    w.begin(); // retry / src change: the old announcement proves nothing about this load
    w.awaitAnnouncement(retry);
    vi.advanceTimersByTime(2_001);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("cancel() drops a pending grace timer (unmount)", () => {
    const w = new ShellLoadWatch(2_000);
    const retry = vi.fn();
    w.begin();
    w.awaitAnnouncement(retry);
    w.cancel();
    vi.advanceTimersByTime(5_000);
    expect(retry).not.toHaveBeenCalled();
  });
});
