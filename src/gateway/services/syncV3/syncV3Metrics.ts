/**
 * Sync V3 in-process metrics — counters for cutover health and auto-rollback triggers.
 * Emitted via telemetry when gateway telemetry client is available.
 */

import type { SyncV3MetricName } from "../../../core/types/syncV3.js";

type CounterMap = Record<SyncV3MetricName, number>;

const COUNTERS: CounterMap = {
  namespace_git_push_count: 0,
  v3_op_count: 0,
  writer_conflict_count: 0,
  oplog_append_latency_p99: 0,
  scheduler_missed_fire_count: 0,
};

/** Optional hook for telemetry bridge (set from gateway init). */
let telemetrySink: ((name: SyncV3MetricName, value: number) => void) | null =
  null;

export function registerSyncV3TelemetrySink(
  sink: (name: SyncV3MetricName, value: number) => void,
): void {
  telemetrySink = sink;
}

export function incrementSyncV3Metric(
  name: SyncV3MetricName,
  delta = 1,
): number {
  COUNTERS[name] += delta;
  telemetrySink?.(name, COUNTERS[name]);
  return COUNTERS[name];
}

export function recordSyncV3Gauge(name: SyncV3MetricName, value: number): void {
  COUNTERS[name] = value;
  telemetrySink?.(name, value);
}

export function getSyncV3Metric(name: SyncV3MetricName): number {
  return COUNTERS[name];
}

export function getSyncV3MetricsSnapshot(): Readonly<CounterMap> {
  return { ...COUNTERS };
}

/** Test-only reset. */
export function resetSyncV3MetricsForTests(): void {
  for (const key of Object.keys(COUNTERS) as SyncV3MetricName[]) {
    COUNTERS[key] = 0;
  }
}
