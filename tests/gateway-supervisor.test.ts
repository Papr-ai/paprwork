/**
 * Gateway Process Supervisor — Unit Tests
 *
 * Tests the pure logic functions extracted from GatewayProcessSupervisor:
 * - Exponential backoff calculation
 * - Circuit breaker threshold detection
 * - State machine transition validation
 * - Health check failure counting
 * - Notification tier selection
 */

import { describe, expect, test } from "vitest";

// Import the pure functions from the logic module (no Electron dependencies)
const {
  calculateBackoff,
  isCircuitBroken,
  pruneTimestamps,
  getNotificationType,
  shouldKillProcess,
  parseHealthResponse,
  shouldKillUnhealthyGateway,
  isValidTransition,
  VALID_STATE_TRANSITIONS,
} = require("../src/electron/supervisor-logic.cjs");

// ---------------------------------------------------------------------------
// Exponential Backoff
// ---------------------------------------------------------------------------
describe("calculateBackoff", () => {
  test("first restart (index 0) returns base delay of 500ms", () => {
    expect(calculateBackoff(0)).toBe(500);
  });

  test("second restart returns 1000ms", () => {
    expect(calculateBackoff(1)).toBe(1000);
  });

  test("third restart returns 2000ms", () => {
    expect(calculateBackoff(2)).toBe(2000);
  });

  test("follows powers of 2 progression", () => {
    const delays = [0, 1, 2, 3, 4, 5].map((i) => calculateBackoff(i));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000]);
  });

  test("caps at 30000ms (default max)", () => {
    expect(calculateBackoff(10)).toBe(30000);
    expect(calculateBackoff(20)).toBe(30000);
  });

  test("respects custom base and max", () => {
    expect(calculateBackoff(0, 100, 1000)).toBe(100);
    expect(calculateBackoff(1, 100, 1000)).toBe(200);
    expect(calculateBackoff(5, 100, 1000)).toBe(1000); // capped
  });
});

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------
describe("isCircuitBroken", () => {
  const WINDOW = 5 * 60 * 1000; // 5 minutes
  const MAX = 5;

  test("not broken with 0 restarts", () => {
    expect(isCircuitBroken([], Date.now(), WINDOW, MAX)).toBe(false);
  });

  test("not broken with 4 restarts in window", () => {
    const now = Date.now();
    const timestamps = [now - 1000, now - 2000, now - 3000, now - 4000];
    expect(isCircuitBroken(timestamps, now, WINDOW, MAX)).toBe(false);
  });

  test("broken with 5 restarts in window", () => {
    const now = Date.now();
    const timestamps = [
      now - 1000,
      now - 2000,
      now - 3000,
      now - 4000,
      now - 5000,
    ];
    expect(isCircuitBroken(timestamps, now, WINDOW, MAX)).toBe(true);
  });

  test("broken with more than 5 restarts in window", () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 8 }, (_, i) => now - i * 1000);
    expect(isCircuitBroken(timestamps, now, WINDOW, MAX)).toBe(true);
  });

  test("old timestamps outside window are ignored", () => {
    const now = Date.now();
    const timestamps = [
      now - 400000, // outside 5-min window
      now - 350000, // outside
      now - 320000, // outside
      now - 1000, // inside
      now - 2000, // inside
    ];
    expect(isCircuitBroken(timestamps, now, WINDOW, MAX)).toBe(false);
  });

  test("exactly at boundary is still in window", () => {
    const now = Date.now();
    const timestamps = [
      now - (WINDOW - 1),
      now - 1000,
      now - 2000,
      now - 3000,
      now - 4000,
    ];
    expect(isCircuitBroken(timestamps, now, WINDOW, MAX)).toBe(true);
  });

  test("exactly at window edge is outside", () => {
    const now = Date.now();
    const timestamps = [
      now - WINDOW, // exactly at boundary = outside
      now - 1000,
      now - 2000,
      now - 3000,
      now - 4000,
    ];
    expect(isCircuitBroken(timestamps, now, WINDOW, MAX)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Timestamp Pruning
// ---------------------------------------------------------------------------
describe("pruneTimestamps", () => {
  const WINDOW = 5 * 60 * 1000;

  test("removes timestamps outside window", () => {
    const now = Date.now();
    const timestamps = [now - 400000, now - 1000, now - 2000];
    const pruned = pruneTimestamps(timestamps, now, WINDOW);
    expect(pruned).toHaveLength(2);
  });

  test("keeps all timestamps inside window", () => {
    const now = Date.now();
    const timestamps = [now - 1000, now - 2000, now - 3000];
    const pruned = pruneTimestamps(timestamps, now, WINDOW);
    expect(pruned).toHaveLength(3);
  });

  test("returns empty array when all timestamps are old", () => {
    const now = Date.now();
    const timestamps = [now - 400000, now - 500000];
    const pruned = pruneTimestamps(timestamps, now, WINDOW);
    expect(pruned).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// State Machine Transitions
// ---------------------------------------------------------------------------
describe("isValidTransition", () => {
  test("stopped → starting is valid", () => {
    expect(isValidTransition("stopped", "starting")).toBe(true);
  });

  test("starting → running is valid (gateway started)", () => {
    expect(isValidTransition("starting", "running")).toBe(true);
  });

  test("starting → backoff is valid (startup failure)", () => {
    expect(isValidTransition("starting", "backoff")).toBe(true);
  });

  test("starting → stopped is valid (intentional stop)", () => {
    expect(isValidTransition("starting", "stopped")).toBe(true);
  });

  test("running → backoff is valid (crash)", () => {
    expect(isValidTransition("running", "backoff")).toBe(true);
  });

  test("running → stopped is valid (intentional stop)", () => {
    expect(isValidTransition("running", "stopped")).toBe(true);
  });

  test("backoff → starting is valid (restart attempt)", () => {
    expect(isValidTransition("backoff", "starting")).toBe(true);
  });

  test("backoff → failed is valid (circuit breaker tripped)", () => {
    expect(isValidTransition("backoff", "failed")).toBe(true);
  });

  test("backoff → stopped is valid (intentional stop during backoff)", () => {
    expect(isValidTransition("backoff", "stopped")).toBe(true);
  });

  test("failed → starting is valid (user clicked Restart)", () => {
    expect(isValidTransition("failed", "starting")).toBe(true);
  });

  test("failed → stopped is valid (user quit)", () => {
    expect(isValidTransition("failed", "stopped")).toBe(true);
  });

  // Invalid transitions
  test("stopped → running is invalid (must go through starting)", () => {
    expect(isValidTransition("stopped", "running")).toBe(false);
  });

  test("running → failed is invalid (must go through backoff)", () => {
    expect(isValidTransition("running", "failed")).toBe(false);
  });

  test("stopped → failed is invalid", () => {
    expect(isValidTransition("stopped", "failed")).toBe(false);
  });

  test("running → starting is invalid", () => {
    expect(isValidTransition("running", "starting")).toBe(false);
  });

  test("failed → running is invalid (must go through starting)", () => {
    expect(isValidTransition("failed", "running")).toBe(false);
  });

  test("all states can transition to stopped", () => {
    const states = Object.keys(VALID_STATE_TRANSITIONS);
    for (const state of states) {
      if (state === "stopped") continue;
      expect(isValidTransition(state, "stopped")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Health Check Failure Counting
// ---------------------------------------------------------------------------
describe("shouldKillProcess", () => {
  test("success resets counter to 0", () => {
    const result = shouldKillProcess(2, true);
    expect(result.newCount).toBe(0);
    expect(result.shouldKill).toBe(false);
  });

  test("success at 0 failures stays at 0", () => {
    const result = shouldKillProcess(0, true);
    expect(result.newCount).toBe(0);
    expect(result.shouldKill).toBe(false);
  });

  test("first failure increments to 1, no kill", () => {
    const result = shouldKillProcess(0, false);
    expect(result.newCount).toBe(1);
    expect(result.shouldKill).toBe(false);
  });

  test("second failure increments to 2, no kill", () => {
    const result = shouldKillProcess(1, false);
    expect(result.newCount).toBe(2);
    expect(result.shouldKill).toBe(false);
  });

  test("third consecutive failure triggers kill (default threshold)", () => {
    const result = shouldKillProcess(2, false);
    expect(result.newCount).toBe(3);
    expect(result.shouldKill).toBe(true);
  });

  test("success after 2 failures resets to 0", () => {
    const result = shouldKillProcess(2, true);
    expect(result.newCount).toBe(0);
    expect(result.shouldKill).toBe(false);
  });

  test("custom threshold of 5", () => {
    expect(shouldKillProcess(3, false, 5).shouldKill).toBe(false);
    expect(shouldKillProcess(4, false, 5).shouldKill).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Health Response Parsing
// ---------------------------------------------------------------------------
describe("parseHealthResponse", () => {
  test('status "ok" is alive and ready', () => {
    const health = parseHealthResponse(JSON.stringify({ status: "ok" }));
    expect(health).toEqual({ alive: true, ready: true });
  });

  test('status "starting" is alive but not ready', () => {
    const health = parseHealthResponse(JSON.stringify({ status: "starting" }));
    expect(health).toEqual({ alive: true, ready: false });
  });

  test('status "switching" is alive but not ready', () => {
    const health = parseHealthResponse(JSON.stringify({ status: "switching" }));
    expect(health).toEqual({ alive: true, ready: false });
  });

  test("invalid JSON is not alive", () => {
    expect(parseHealthResponse("not-json")).toEqual({
      alive: false,
      ready: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Startup Grace (do not kill gateway while still starting)
// ---------------------------------------------------------------------------
describe("shouldKillUnhealthyGateway", () => {
  test("starting status never triggers kill before first ok", () => {
    const health = { alive: true, ready: false };
    expect(
      shouldKillUnhealthyGateway(10, health, false, 5).shouldKill,
    ).toBe(false);
  });

  test("switching status never triggers kill while gateway was healthy", () => {
    const health = { alive: true, ready: false };
    expect(
      shouldKillUnhealthyGateway(4, health, true, 5).shouldKill,
    ).toBe(false);
    expect(
      shouldKillUnhealthyGateway(4, health, true, 5).newCount,
    ).toBe(0);
  });

  test("ok status resets failures", () => {
    const health = { alive: true, ready: true };
    expect(
      shouldKillUnhealthyGateway(4, health, true, 5).shouldKill,
    ).toBe(false);
    expect(
      shouldKillUnhealthyGateway(4, health, true, 5).newCount,
    ).toBe(0);
  });

  test("kill only after gateway was healthy and failures accumulate", () => {
    const dead = { alive: false, ready: false };
    expect(
      shouldKillUnhealthyGateway(4, dead, true, 5).shouldKill,
    ).toBe(true);
    expect(
      shouldKillUnhealthyGateway(4, dead, false, 5).shouldKill,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Notification Tiers
// ---------------------------------------------------------------------------
describe("getNotificationType", () => {
  test("restart 1 is silent", () => {
    expect(getNotificationType(1)).toBe("silent");
  });

  test("restart 2 is silent", () => {
    expect(getNotificationType(2)).toBe("silent");
  });

  test("restart 3 shows banner", () => {
    expect(getNotificationType(3)).toBe("banner");
  });

  test("restart 4 shows banner", () => {
    expect(getNotificationType(4)).toBe("banner");
  });

  test("restart 5 shows dialog", () => {
    expect(getNotificationType(5)).toBe("dialog");
  });

  test("restart 10 shows dialog", () => {
    expect(getNotificationType(10)).toBe("dialog");
  });

  test("custom thresholds", () => {
    expect(getNotificationType(1, 1, 3)).toBe("silent");
    expect(getNotificationType(2, 1, 3)).toBe("banner");
    expect(getNotificationType(4, 1, 3)).toBe("dialog");
  });
});
