/**
 * Sleep/wake recovery for the gateway socket.
 *
 * Reported as: close the laptop lid mid-turn, reopen it, and the app shows
 * "Gateway connection timeout" plus "Connection lost — check Gateway" while a
 * reconnect was already under way. Two defects, both pinned here.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveGatewayConnectionState,
  WS_CONNECTING,
  WS_OPEN,
} from "../ui/utils/gatewayConnectionState";
import {
  deadlineSpannedSuspend,
  scheduleSuspendAwareTimeout,
  FROZEN_EXCESS_FLOOR_MS,
  MAX_SUSPEND_REARMS,
} from "../ui/utils/suspendAwareDeadline";

const WS_CLOSED = 3;
const MAX_ATTEMPTS = 30;

function state(overrides: Partial<Parameters<typeof resolveGatewayConnectionState>[0]>) {
  return resolveGatewayConnectionState({
    readyState: null,
    degraded: false,
    reconnectAttempts: 0,
    maxReconnectAttempts: MAX_ATTEMPTS,
    hasEverConnected: false,
    ...overrides,
  });
}

describe("resolveGatewayConnectionState", () => {
  it("reports reconnecting when a connect is in flight after a reset counter", () => {
    // The reported bug. The `system:resume` handler zeroes reconnectAttempts to
    // drop the backoff, then connects — and the old derivation read
    // "reconnecting" off that same counter, so this said "disconnected" and the
    // indicator told the user to check a gateway that was fine.
    expect(
      state({
        readyState: WS_CONNECTING,
        reconnectAttempts: 0,
        hasEverConnected: true,
      }),
    ).toBe("reconnecting");
  });

  it("reports disconnected for the initial connect at boot", () => {
    // Must NOT be "reconnecting": ConnectionIndicator only surfaces the
    // supervisor's "Gateway starting..." message while the state is
    // "disconnected", and the gateway legitimately takes 60s+ to become ready.
    expect(
      state({
        readyState: WS_CONNECTING,
        reconnectAttempts: 0,
        hasEverConnected: false,
      }),
    ).toBe("disconnected");
  });

  it("reports reconnecting on the ordinary close path", () => {
    // attemptReconnect() increments before scheduling, so this path was always
    // labelled correctly — the regression was unique to resume.
    expect(
      state({ readyState: WS_CLOSED, reconnectAttempts: 1, hasEverConnected: true }),
    ).toBe("reconnecting");
  });

  it("reports disconnected once attempts are exhausted", () => {
    expect(
      state({
        readyState: WS_CLOSED,
        reconnectAttempts: MAX_ATTEMPTS,
        hasEverConnected: true,
      }),
    ).toBe("disconnected");
  });

  it("reports connected and degraded only while the socket is open", () => {
    expect(state({ readyState: WS_OPEN })).toBe("connected");
    expect(state({ readyState: WS_OPEN, degraded: true })).toBe("degraded");
    // A stale degraded flag must not leak into a closed socket: the indicator
    // renders "degraded" as "Gateway busy — still working", which is a claim
    // that the connection is alive.
    expect(
      state({
        readyState: WS_CLOSED,
        degraded: true,
        reconnectAttempts: 1,
        hasEverConnected: true,
      }),
    ).toBe("reconnecting");
  });

  it("reports disconnected when no socket exists at all", () => {
    expect(state({ readyState: null, hasEverConnected: true })).toBe(
      "disconnected",
    );
  });
});

describe("deadlineSpannedSuspend", () => {
  const base = { delayMs: 30_000, armedAtMs: 1_000_000, lastResumeAtMs: 0 };

  it("detects a suspend from a recorded resume after arming", () => {
    expect(
      deadlineSpannedSuspend({
        ...base,
        nowMs: base.armedAtMs + 30_000,
        lastResumeAtMs: base.armedAtMs + 10,
      }),
    ).toBe(true);
  });

  it("ignores a resume recorded before the deadline was armed", () => {
    // Waking up does not excuse a request issued after the wake.
    expect(
      deadlineSpannedSuspend({
        ...base,
        nowMs: base.armedAtMs + 30_000,
        lastResumeAtMs: base.armedAtMs - 1,
      }),
    ).toBe(false);
  });

  it("detects a suspend from elapsed wall clock with no resume event", () => {
    // The timer and the resume IPC race on wake. If the timer wins, no resume
    // has been recorded yet — so elapsed time has to carry the detection by
    // itself, or the fix has a hole exactly where the bug lives.
    expect(
      deadlineSpannedSuspend({
        ...base,
        nowMs: base.armedAtMs + 8 * 60 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it("does not treat an ordinarily late timer as a suspend", () => {
    // A loaded renderer firing a 30s timer 6s late must still time out, or a
    // genuinely unreachable gateway is reported 90s late instead of 30s.
    expect(
      deadlineSpannedSuspend({ ...base, nowMs: base.armedAtMs + 36_000 }),
    ).toBe(false);
  });

  it("keeps a floor on the excess so short delays are not false positives", () => {
    const short = { delayMs: 1_000, armedAtMs: 0, lastResumeAtMs: 0 };
    // 1s delay firing at 9s: suspicious, but under the 10s floor, so not
    // claimed as a suspend. Without the floor this would be 2s.
    expect(
      deadlineSpannedSuspend({ ...short, nowMs: FROZEN_EXCESS_FLOOR_MS - 1_000 }),
    ).toBe(false);
    expect(
      deadlineSpannedSuspend({ ...short, nowMs: FROZEN_EXCESS_FLOOR_MS + 2_000 }),
    ).toBe(true);
  });
});

describe("scheduleSuspendAwareTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires normally when no suspend occurred", () => {
    const onExpire = vi.fn();
    scheduleSuspendAwareTimeout({
      delayMs: 30_000,
      onExpire,
      getLastResumeAtMs: () => 0,
    });

    vi.advanceTimersByTime(29_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("re-arms instead of expiring when the deadline spanned a suspend", () => {
    const onExpire = vi.fn();
    const onRearm = vi.fn();
    let resumeAt = 0;

    scheduleSuspendAwareTimeout({
      delayMs: 30_000,
      onExpire,
      onRearm,
      getLastResumeAtMs: () => resumeAt,
    });

    // The lid closes 1s in and the machine sleeps an hour. Fake timers do not
    // freeze, so advance the clock the way a suspend does — the timer fires
    // overdue with a resume recorded after it was armed.
    resumeAt = Date.now() + 1_000;
    vi.advanceTimersByTime(30_000);

    expect(onExpire).not.toHaveBeenCalled();
    expect(onRearm).toHaveBeenCalledTimes(1);

    // Fresh budget from the moment it re-armed.
    vi.advanceTimersByTime(29_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("stops re-arming after the cap so a caller cannot wait forever", () => {
    const onExpire = vi.fn();
    const onRearm = vi.fn();
    let resumeAt = 0;

    scheduleSuspendAwareTimeout({
      delayMs: 1_000,
      onExpire,
      onRearm,
      getLastResumeAtMs: () => resumeAt,
    });

    // A machine suspending on every cycle. Bounded: the promise must reject
    // eventually, because a caller pending indefinitely is worse than a
    // timeout that is arguably premature.
    for (let i = 0; i <= MAX_SUSPEND_REARMS; i += 1) {
      resumeAt = Date.now() + 1;
      vi.advanceTimersByTime(1_000);
    }

    expect(onRearm).toHaveBeenCalledTimes(MAX_SUSPEND_REARMS);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("does not fire after cancel, and cancel is idempotent", () => {
    const onExpire = vi.fn();
    const cancel = scheduleSuspendAwareTimeout({
      delayMs: 5_000,
      onExpire,
      getLastResumeAtMs: () => 0,
    });

    cancel();
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("reads the resume timestamp at fire time, not at arm time", () => {
    // The getter exists because the resume happens *after* arming by
    // definition. Capturing the value up front would detect nothing.
    const onExpire = vi.fn();
    const getLastResumeAtMs = vi.fn(() => 0);

    scheduleSuspendAwareTimeout({
      delayMs: 1_000,
      onExpire,
      getLastResumeAtMs,
    });

    expect(getLastResumeAtMs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(getLastResumeAtMs).toHaveBeenCalled();
  });
});

/** Strip comments so a rationale that *names* the old code cannot pass for it. */
function strippedSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the system:resume handler probes a socket that still reports OPEN", () => {
  const source = strippedSource("ui/src/lib/gateway.ts");

  it("still registers a system:resume listener", () => {
    // Guard the guard: a rename would otherwise make the assertions below pass
    // against a handler that no longer exists.
    expect(source).toContain("addEventListener('system:resume'");
  });

  it("calls probeConnection rather than relying on isConnected()", () => {
    const start = source.indexOf("addEventListener('system:resume'");
    const body = source.slice(start, start + 900);

    // `isConnected()` is readyState === OPEN, which is precisely what a
    // half-open socket reports after a suspend — so the old guard did nothing
    // and detection fell to the heartbeat's 240s budget.
    expect(body).toContain("probeConnection");
    expect(body).not.toContain("!this.isConnected()");
  });

  it("records the resume timestamp for suspend-aware deadlines", () => {
    const start = source.indexOf("addEventListener('system:resume'");
    const body = source.slice(start, start + 900);
    expect(body).toContain("this.lastResumeAtMs = Date.now()");
  });

  it("uses suspend-aware deadlines at both 30s timeout sites", () => {
    // Call sites only. Counting the bare identifier also matches the import,
    // so reverting one site still totalled two and the guard survived the
    // mutation that proved it.
    const callSites = source.split("scheduleSuspendAwareTimeout({").length - 1;
    expect(callSites).toBe(2);

    // Each timeout rejection must be reached through onExpire rather than a
    // plain setTimeout, which would fire overdue on wake and report a timeout
    // no code was running to meet. Checked per message because the timer shape
    // is not a usable signal: probeConnection's own setTimeout legitimately
    // ends in `}, timeoutMs)`.
    for (const message of ["Gateway connection timeout", "Request timeout"]) {
      const idx = source.indexOf(`new Error("${message}")`);
      expect(idx, `${message} rejection is missing`).toBeGreaterThan(-1);
      expect(
        source.slice(Math.max(0, idx - 400), idx),
        `${message} is not guarded by a suspend-aware deadline`,
      ).toContain("onExpire:");
    }
  });
});
