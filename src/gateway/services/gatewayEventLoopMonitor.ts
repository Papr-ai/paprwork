/**
 * Samples Node event-loop delay for diagnostics when liveness checks fail or lag spikes.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

let histogram: IntervalHistogram | null = null;

export function startGatewayEventLoopMonitor(): void {
  if (histogram) {
    return;
  }
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
}

export function stopGatewayEventLoopMonitor(): void {
  if (!histogram) {
    return;
  }
  histogram.disable();
  histogram = null;
}

/** Mean event-loop delay in ms since last reset, or 0 if monitor not started. */
export function sampleEventLoopLagMs(reset = true): number {
  if (!histogram) {
    return 0;
  }
  const meanNs = histogram.mean;
  if (reset) {
    histogram.reset();
  }
  if (!Number.isFinite(meanNs)) {
    return 0;
  }
  return meanNs / 1_000_000;
}

export function logEventLoopLagIfHigh(
  context: string,
  thresholdMs = 500,
): number {
  const lagMs = sampleEventLoopLagMs(true);
  if (lagMs >= thresholdMs) {
    console.warn(
      `[GatewayEventLoop] ${context}: mean event-loop delay ${lagMs.toFixed(0)}ms`,
    );
  }
  return lagMs;
}
