import { describe, expect, it } from "vitest";
import {
  bootstrapRetryReadyAtMs,
  type BootstrapPendingMarker,
} from "../src/gateway/services/tursoReplica/tursoReplicaBootstrapMarker.js";

const marker = (attempts: number, lastAttemptMs?: number): BootstrapPendingMarker => ({
  reason: "engine_panic_sidecar_reset",
  rowsAtRepair: 10,
  writtenAtMs: 0,
  attempts,
  lastAttemptMs,
} as BootstrapPendingMarker);

describe("bootstrapRetryReadyAtMs", () => {
  it("returns 0 when there was never an attempt", () => {
    expect(bootstrapRetryReadyAtMs(marker(0), 1_000)).toBe(0);
  });

  it("allows an immediate attempt when the last failure was in a previous launch", () => {
    // 8 attempts → 15 min cap; failure 1 min before this process started.
    const startedAt = 10_000_000;
    expect(bootstrapRetryReadyAtMs(marker(8, startedAt - 60_000), startedAt)).toBe(0);
  });

  it("keeps exponential backoff for failures in the current launch", () => {
    const startedAt = 10_000_000;
    const last = startedAt + 1_000;
    expect(bootstrapRetryReadyAtMs(marker(8, last), startedAt)).toBe(last + 15 * 60_000);
    expect(bootstrapRetryReadyAtMs(marker(1, last), startedAt)).toBe(last + 10_000);
  });
});
