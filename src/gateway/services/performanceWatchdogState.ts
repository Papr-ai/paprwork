/** Monotonic liveness policy, independent of OS probes and gateway event loop. */
export class WatchdogLiveness {
  private lastHeartbeat: number | null = null;
  private lastTick: number | null = null;
  private lastCapture = -Infinity;
  private capturingThisStall = false;
  constructor(readonly thresholdMs = 2500, readonly cooldownMs = 60_000) {}
  heartbeat(now: number): void { this.lastHeartbeat = now; this.capturingThisStall = false; }
  tick(now: number): { heartbeatAgeMs: number | null; observerGapMs: number; capture: boolean } {
    const observerGapMs = this.lastTick === null ? 0 : Math.max(0, now - this.lastTick - 500);
    this.lastTick = now;
    // A sleeping/starved observer cannot attribute the gap to the gateway.
    if (observerGapMs > 1500) { this.lastHeartbeat = now; this.capturingThisStall = false; }
    const heartbeatAgeMs = this.lastHeartbeat === null ? null : now - this.lastHeartbeat;
    const capture = heartbeatAgeMs !== null && heartbeatAgeMs >= this.thresholdMs &&
      !this.capturingThisStall && now - this.lastCapture >= this.cooldownMs;
    if (capture) { this.lastCapture = now; this.capturingThisStall = true; }
    return { heartbeatAgeMs, observerGapMs, capture };
  }
}
