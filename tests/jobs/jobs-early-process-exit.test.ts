import { EventEmitter } from "events";
import { describe, expect, test } from "vitest";
import { captureEarlyProcessExit } from "../../src/gateway/services/JobsService.js";

/**
 * A fast command (`echo hello`) can exit while runSingleAttempt is still
 * awaiting log writes. Before the fix the "close" listener was attached after
 * those awaits, missed the event, and the job sat in "running" until the
 * 30-minute watchdog — every shell job on Linux CI.
 */
describe("captureEarlyProcessExit", () => {
  test("replays a close that happened before the handler was attached", async () => {
    const proc = new EventEmitter() as unknown as import("child_process").ChildProcess;
    const early = captureEarlyProcessExit(proc);
    proc.emit("close", 0);

    const code = await new Promise<number | null>((resolve) => early.onClose(resolve));
    expect(code).toBe(0);
  });

  test("delivers a close that happens after the handler is attached", () => {
    const proc = new EventEmitter() as unknown as import("child_process").ChildProcess;
    const early = captureEarlyProcessExit(proc);
    const seen: Array<number | null> = [];
    early.onClose((c) => seen.push(c));
    proc.emit("close", 3);
    expect(seen).toEqual([3]);
  });

  test("replays an early spawn error", () => {
    const proc = new EventEmitter() as unknown as import("child_process").ChildProcess;
    const early = captureEarlyProcessExit(proc);
    proc.emit("error", new Error("ENOENT"));
    const seen: string[] = [];
    early.onError((e) => seen.push(e.message));
    expect(seen).toEqual(["ENOENT"]);
  });
});
