/**
 * Per-request phase timings for mini-app replica reads (AsyncLocalStorage).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface ReplicaReadPhaseTrace {
  label: string;
  startedAt: number;
  phases: Record<string, number>;
  meta: Record<string, string | number | boolean>;
}

const store = new AsyncLocalStorage<ReplicaReadPhaseTrace>();

const recentTraces: Array<{
  at: string;
  label: string;
  totalMs: number;
  phases: Record<string, number>;
  meta: Record<string, string | number | boolean>;
}> = [];
const RECENT_MAX = 80;

function readLogThresholdMs(): number {
  const raw = process.env.REPLICA_READ_TRACE_SLOW_MS?.trim();
  if (!raw) {
    return 1000;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
}

function traceLoggingEnabled(): boolean {
  return process.env.REPLICA_READ_TRACE === "1" || process.env.REPLICA_READ_TRACE === "true";
}

export function getReplicaReadTraceStore(): ReplicaReadPhaseTrace | undefined {
  return store.getStore();
}

export function withReplicaReadTrace<T>(
  label: string,
  meta: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  const trace: ReplicaReadPhaseTrace = {
    label,
    startedAt: performance.now(),
    phases: {},
    meta: { ...meta },
  };
  return store.run(trace, fn);
}

export function setReplicaReadMeta(
  fields: Record<string, string | number | boolean>,
): void {
  const trace = store.getStore();
  if (!trace) {
    return;
  }
  Object.assign(trace.meta, fields);
}

export function markReplicaReadPhase(name: string, ms: number): void {
  const trace = store.getStore();
  if (!trace || !Number.isFinite(ms) || ms < 0) {
    return;
  }
  trace.phases[name] = Math.round((trace.phases[name] ?? 0) + ms);
}

export async function timeReplicaReadPhase<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    markReplicaReadPhase(name, performance.now() - start);
  }
}

export function finishReplicaReadTrace(extraMeta?: Record<string, string | number | boolean>): void {
  const trace = store.getStore();
  if (!trace) {
    return;
  }
  if (extraMeta) {
    Object.assign(trace.meta, extraMeta);
  }
  const totalMs = Math.round(performance.now() - trace.startedAt);
  const phases = { ...trace.phases };
  const accountedMs = Object.values(phases).reduce((sum, ms) => sum + ms, 0);
  const unaccountedMs = totalMs - accountedMs;
  if (unaccountedMs > 50) {
    phases.unaccountedMs = unaccountedMs;
  }

  const shouldLog =
    traceLoggingEnabled() ||
    totalMs >= readLogThresholdMs() ||
    Object.values(phases).some((ms) => ms >= 500);

  if (shouldLog) {
    const parts = Object.entries(phases)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}ms`)
      .join(" ");
    console.warn(
      `[ReplicaReadPhases] total=${totalMs}ms label=${trace.label} ${parts}`,
    );
  }

  recentTraces.push({
    at: new Date().toISOString(),
    label: trace.label,
    totalMs,
    phases,
    meta: { ...trace.meta },
  });
  while (recentTraces.length > RECENT_MAX) {
    recentTraces.shift();
  }
}

export function getRecentReplicaReadPhaseTraces(): typeof recentTraces {
  return [...recentTraces];
}

/** @internal */
export function resetReplicaReadPhaseTracesForTests(): void {
  recentTraces.length = 0;
}
