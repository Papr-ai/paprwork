/**
 * Parallel publish sizing + per-phase timings.
 *
 * Publishing is mostly waiting: the network (writer, Turso), esbuild in its
 * own process, and git in child processes. Running several apps at once
 * overlaps those waits. The limit drops when the gateway event loop is
 * lagging, so a heavily loaded machine sheds publish work before the UI feels
 * it — new flushes wait, running ones finish.
 */

import os from "node:os";

const DEFAULT_MAX = 4;
const HARD_MAX = 10;
const LAG_SHED_MS = 250;
const MAX_TIMING_RECORDS = 100;

function readEnvInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

/** Most flushes allowed at once on this machine (before load shedding). */
export function resolveFlushConcurrencyCeiling(): number {
  const override = readEnvInt("PAPR_FLUSH_CONCURRENCY");
  if (override !== undefined) {
    return Math.max(1, Math.min(HARD_MAX, override));
  }
  const cpus = os.cpus().length;
  return Math.max(2, Math.min(DEFAULT_MAX, cpus - 1));
}

let lagSampler: (() => number) | null = null;

/** Test seam + lazy wiring to the gateway event loop monitor. */
export function setFlushLagSampler(sampler: (() => number) | null): void {
  lagSampler = sampler;
}

function currentLagMs(): number {
  if (!lagSampler) {
    return 0;
  }
  try {
    return lagSampler();
  } catch {
    return 0;
  }
}

/** Flushes allowed to start now: the ceiling, halved while the gateway lags. */
export function resolveFlushConcurrency(): number {
  const ceiling = resolveFlushConcurrencyCeiling();
  return currentLagMs() >= LAG_SHED_MS ? Math.max(1, Math.floor(ceiling / 2)) : ceiling;
}

export interface FlushPhaseTiming {
  layer: string;
  label: string;
  startedAtMs: number;
  durationMs: number;
}

export interface FlushTimingRecord {
  appId: string;
  trigger: string;
  queuedMs: number;
  durationMs: number;
  outcome: "ok" | "error";
  error?: string;
  phases?: FlushPhaseTiming[];
  finishedAt?: string;
}

const openPhases = new Map<string, FlushPhaseTiming[]>();
const recentFlushTimings: FlushTimingRecord[] = [];

/** Close the previous phase for this app and open a new one. */
export function noteFlushPhase(appId: string, layer: string, label: string): void {
  const now = Date.now();
  const phases = openPhases.get(appId) ?? [];
  const last = phases[phases.length - 1];
  if (last && last.durationMs < 0) {
    last.durationMs = now - last.startedAtMs;
  }
  phases.push({ layer, label, startedAtMs: now, durationMs: -1 });
  openPhases.set(appId, phases);
}

export function takeFlushPhaseTimings(appId: string): FlushPhaseTiming[] {
  const phases = openPhases.get(appId) ?? [];
  openPhases.delete(appId);
  const last = phases[phases.length - 1];
  if (last && last.durationMs < 0) {
    last.durationMs = Date.now() - last.startedAtMs;
  }
  return phases;
}

export function recordFlushTiming(record: FlushTimingRecord): void {
  recentFlushTimings.push({ ...record, finishedAt: new Date().toISOString() });
  if (recentFlushTimings.length > MAX_TIMING_RECORDS) {
    recentFlushTimings.splice(0, recentFlushTimings.length - MAX_TIMING_RECORDS);
  }
  const phases = (record.phases ?? [])
    .map((phase) => `${phase.label.replace(/…$/, "")}=${Math.round(phase.durationMs)}ms`)
    .join(" ");
  console.log(
    `[SyncCoordinator] flush ${record.outcome} app=${record.appId} trigger=${record.trigger} ` +
      `queued=${record.queuedMs}ms took=${record.durationMs}ms ${phases}`,
  );
}

/** Recent flushes (newest last) for /api/debug/gateway-performance. */
export function getRecentFlushTimings(): FlushTimingRecord[] {
  return [...recentFlushTimings];
}

export function clearFlushTimingsForTests(): void {
  recentFlushTimings.length = 0;
  openPhases.clear();
}
