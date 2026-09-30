/**
 * Issue: a finished turn that reached nobody.
 *
 * The turn completed and was billed; the composer span forever. Two halves are
 * covered here: the watchdog that notices total silence, and the invariant that
 * it can never grow into an inter-chunk idle timeout — which would kill working
 * turns, since a single long tool call legitimately emits nothing for minutes.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { isExpectedStreamCancellation } from "../src/core/constants/streamCancellation.js";
import {
  armFirstChunkWatchdog,
  disarmFirstChunkWatchdog,
  isFirstChunkWatchdogArmed,
  noteStreamChunkArrived,
  resetFirstChunkWatchdogForTests,
  FIRST_CHUNK_STALL_CANCEL_REASON,
  FIRST_CHUNK_STALL_MS,
  type FirstChunkStall,
} from "../ui/lib/agentFirstChunkWatchdog";

describe("first-chunk watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFirstChunkWatchdogForTests();
  });

  afterEach(() => {
    resetFirstChunkWatchdogForTests();
    vi.useRealTimers();
  });

  function arm(chatId: string, requestId: string, onStall = vi.fn()) {
    const armed = armFirstChunkWatchdog({ chatId, requestId, onStall });
    return { armed, onStall };
  }

  it("fires when a stream delivers nothing at all", () => {
    const { armed, onStall } = arm("chat-1", "req-1");
    expect(armed).toBe(true);

    vi.advanceTimersByTime(FIRST_CHUNK_STALL_MS);

    expect(onStall).toHaveBeenCalledTimes(1);
    const stall = onStall.mock.calls[0][0] as FirstChunkStall;
    expect(stall.chatId).toBe("chat-1");
    expect(stall.requestId).toBe("req-1");
    expect(stall.waitedMs).toBeGreaterThanOrEqual(FIRST_CHUNK_STALL_MS);
  });

  it("does not fire once a chunk has arrived", () => {
    const { onStall } = arm("chat-1", "req-1");

    vi.advanceTimersByTime(1_000);
    noteStreamChunkArrived("chat-1", "req-1");
    vi.advanceTimersByTime(FIRST_CHUNK_STALL_MS * 10);

    expect(onStall).not.toHaveBeenCalled();
    expect(isFirstChunkWatchdogArmed("chat-1")).toBe(false);
  });

  /**
   * THE load-bearing invariant. A turn that reported in and then went quiet for
   * an hour inside one bash call is healthy, and interrupting it would be a
   * regression worse than the bug this fixes. Re-arming a delivered request is
   * the only way this could degrade into an idle timeout, so it is refused at
   * the arm call rather than guarded at the timer.
   */
  it("refuses to re-arm a request that already delivered", () => {
    arm("chat-1", "req-1");
    noteStreamChunkArrived("chat-1", "req-1");

    const second = arm("chat-1", "req-1");
    expect(second.armed).toBe(false);

    vi.advanceTimersByTime(FIRST_CHUNK_STALL_MS * 10);
    expect(second.onStall).not.toHaveBeenCalled();
    expect(isFirstChunkWatchdogArmed("chat-1")).toBe(false);
  });

  it("refuses to re-arm a request that already stalled", () => {
    const { onStall } = arm("chat-1", "req-1");
    vi.advanceTimersByTime(FIRST_CHUNK_STALL_MS);
    expect(onStall).toHaveBeenCalledTimes(1);

    const second = arm("chat-1", "req-1");
    expect(second.armed).toBe(false);

    vi.advanceTimersByTime(FIRST_CHUNK_STALL_MS * 10);
    expect(second.onStall).not.toHaveBeenCalled();
    // And the original fired exactly once, not once per elapsed budget.
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("a chunk from a superseded stream does not vouch for the armed one", () => {
    arm("chat-1", "old-req");
    const { onStall } = arm("chat-1", "new-req");

    // A late chunk from the replaced stream arrives.
    noteStreamChunkArrived("chat-1", "old-req");

    vi.advanceTimersByTime(FIRST_CHUNK_STALL_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect((onStall.mock.calls[0][0] as FirstChunkStall).requestId).toBe(
      "new-req",
    );
  });

  it("a broadcast chunk with no requestId disarms the armed stream", () => {
    const { onStall } = arm("chat-1", "req-1");

    // Workspace broadcasts carry chatId but no requestId — the server-side
    // fallback for a completion that reached no subscriber. It is still
    // delivery, so it must count.
    noteStreamChunkArrived("chat-1");

    vi.advanceTimersByTime(FIRST_CHUNK_STALL_MS);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("arming a new request supersedes the previous timer for that chat", () => {
    const first = arm("chat-1", "req-1");
    const second = arm("chat-1", "req-2");
    expect(second.armed).toBe(true);

    vi.advanceTimersByTime(FIRST_CHUNK_STALL_MS);

    expect(first.onStall).not.toHaveBeenCalled();
    expect(second.onStall).toHaveBeenCalledTimes(1);
  });

  it("tracks chats independently", () => {
    const a = arm("chat-a", "req-a");
    const b = arm("chat-b", "req-b");

    noteStreamChunkArrived("chat-b", "req-b");
    vi.advanceTimersByTime(FIRST_CHUNK_STALL_MS);

    expect(a.onStall).toHaveBeenCalledTimes(1);
    expect(b.onStall).not.toHaveBeenCalled();
  });

  it("disarm stops the timer and retires the request", () => {
    const { onStall } = arm("chat-1", "req-1");

    disarmFirstChunkWatchdog("chat-1");
    expect(isFirstChunkWatchdogArmed("chat-1")).toBe(false);

    vi.advanceTimersByTime(FIRST_CHUNK_STALL_MS);
    expect(onStall).not.toHaveBeenCalled();

    // Retired, so a stale re-arm for the same request is refused.
    expect(arm("chat-1", "req-1").armed).toBe(false);
  });

  it("disarming an unwatched chat is a no-op", () => {
    expect(() => disarmFirstChunkWatchdog("nobody")).not.toThrow();
    expect(isFirstChunkWatchdogArmed("nobody")).toBe(false);
  });

  /**
   * The cancel reason releases the original promise via
   * `gateway.cancelRequest`, which only *resolves* for reasons the shared
   * matcher considers expected — anything else rejects, surfacing an error for
   * a turn that is about to be recovered and displayed. Pinned here because
   * the matcher lives in another module and tightening it would break this
   * silently.
   */
  it("the stall cancel reason resolves rather than rejects the stream", () => {
    expect(isExpectedStreamCancellation(FIRST_CHUNK_STALL_CANCEL_REASON)).toBe(
      true,
    );
  });

  it("budget is under the heartbeat's active-stream tolerance", () => {
    // Heartbeat while a stream is active: 12 missed beats x 20s = 240s. The
    // watchdog exists because that is too long to stare at dots, so it must
    // fire well before it, and well after a worst-case ~15-20s first chunk.
    expect(FIRST_CHUNK_STALL_MS).toBeLessThan(240_000);
    expect(FIRST_CHUNK_STALL_MS).toBeGreaterThanOrEqual(30_000);
  });
});
