/** Non-destructive diagnostics with fixed windows, sampled in the gateway process. */
import { monitorEventLoopDelay, PerformanceObserver, performance, type IntervalHistogram } from "node:perf_hooks";
import os from "node:os";
import { getHeapStatistics } from "node:v8";
import { startPerformanceWatchdog, stopPerformanceWatchdog, getPerformanceWatchdogDiagnostics } from "./performanceWatchdog.js";
import { getActiveDiagnosticOperationIds } from "../../core/utils/performanceDiagnostics.js";

const SAMPLE_MS = 5000;
const MAX_SAMPLES = 120;
let histogram: IntervalHistogram | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let observer: PerformanceObserver | undefined;
let windowStartedAt = "";
let previousCpu = process.cpuUsage();
let previousMono = performance.now();
let previousUsage = process.resourceUsage();
let previousUtilization = performance.eventLoopUtilization();
let gcCount = 0;
let gcTotalMs = 0;
let gcMaxMs = 0;
const gcEvents: Array<{ startedAt: string; durationMs: number }> = [];

export interface EventLoopStats { meanMs: number; p95Ms: number; maxMs: number; count: number }
export interface GatewayResourceSample {
  startedAt: string; finishedAt: string; elapsedMs: number;
  eventLoop: EventLoopStats;
  cpuPercentOfOneCore: number;
  memory: ReturnType<typeof process.memoryUsage>;
  system: { freeMemoryBytes: number; totalMemoryBytes: number; loadAverage: number[] };
  gc: { count: number; totalMs: number; maxMs: number };
  activeOperationIds: string[];
  runtime?: {
    eventLoopUtilization: number; eventLoopActiveMs: number; eventLoopIdleMs: number;
    heapLimitBytes: number; heapUsedPercentOfLimit: number;
    resourceUsageDelta: { minorPageFaults: number; majorPageFaults: number; fsRead: number; fsWrite: number;
      voluntaryContextSwitches: number; involuntaryContextSwitches: number };
  };
}
const samples: GatewayResourceSample[] = [];

function readHistogram(): EventLoopStats {
  const ms = (ns: number) => Number.isFinite(ns) ? ns / 1_000_000 : 0;
  if (!histogram || histogram.count === 0) return { meanMs: 0, p95Ms: 0, maxMs: 0, count: 0 };
  return { meanMs: ms(histogram.mean), p95Ms: ms(histogram.percentile(95)), maxMs: ms(histogram.max), count: histogram.count };
}

export function collectGatewayResourceSample(): GatewayResourceSample | null {
  if (!histogram) return null;
  const now = performance.now();
  const elapsedMs = now - previousMono;
  const cpu = process.cpuUsage();
  const usage = process.resourceUsage();
  const utilization = performance.eventLoopUtilization();
  const delta = performance.eventLoopUtilization(utilization, previousUtilization);
  const heap = getHeapStatistics();
  const usageDelta = (key: keyof typeof usage) => Math.max(0, usage[key] - previousUsage[key]);
  const sample: GatewayResourceSample = {
    startedAt: windowStartedAt, finishedAt: new Date().toISOString(), elapsedMs,
    eventLoop: readHistogram(),
    cpuPercentOfOneCore: elapsedMs > 0 ? ((cpu.user - previousCpu.user) + (cpu.system - previousCpu.system)) / (elapsedMs * 1000) * 100 : 0,
    memory: process.memoryUsage(),
    runtime: { eventLoopUtilization: delta.utilization, eventLoopActiveMs: delta.active, eventLoopIdleMs: delta.idle,
      heapLimitBytes: heap.heap_size_limit, heapUsedPercentOfLimit: heap.used_heap_size / heap.heap_size_limit * 100,
      resourceUsageDelta: { minorPageFaults: usageDelta("minorPageFault"), majorPageFaults: usageDelta("majorPageFault"),
        fsRead: usageDelta("fsRead"), fsWrite: usageDelta("fsWrite"),
        voluntaryContextSwitches: usageDelta("voluntaryContextSwitches"), involuntaryContextSwitches: usageDelta("involuntaryContextSwitches") } },
    system: { freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem(), loadAverage: os.loadavg() },
    gc: { count: gcCount, totalMs: gcTotalMs, maxMs: gcMaxMs },
    activeOperationIds: getActiveDiagnosticOperationIds(),
  };
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();
  previousUsage = usage; previousUtilization = utilization;
  previousCpu = cpu; previousMono = now; windowStartedAt = sample.finishedAt;
  gcCount = 0; gcTotalMs = 0; gcMaxMs = 0;
  histogram.reset();
  return sample;
}

export function startGatewayEventLoopMonitor(): void {
  if (histogram) return;
  samples.length = 0; gcEvents.length = 0;
  gcCount = 0; gcTotalMs = 0; gcMaxMs = 0;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  previousCpu = process.cpuUsage(); previousMono = performance.now();
  previousUsage = process.resourceUsage(); previousUtilization = performance.eventLoopUtilization();
  windowStartedAt = new Date().toISOString();
  observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      gcCount++; gcTotalMs += entry.duration; gcMaxMs = Math.max(gcMaxMs, entry.duration);
      gcEvents.push({ startedAt: new Date(performance.timeOrigin + entry.startTime).toISOString(), durationMs: entry.duration });
      if (gcEvents.length > MAX_SAMPLES) gcEvents.shift();
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  timer = setInterval(collectGatewayResourceSample, SAMPLE_MS);
  timer.unref();
  startPerformanceWatchdog();
}

export function stopGatewayEventLoopMonitor(): void {
  stopPerformanceWatchdog();
  if (timer) clearInterval(timer);
  timer = undefined;
  observer?.disconnect(); observer = undefined;
  histogram?.disable(); histogram = null;
}

export function getGatewayResourceDiagnostics() {
  return {
    running: histogram !== null, sampleIntervalMs: SAMPLE_MS, maxSamples: MAX_SAMPLES,
    currentWindow: { startedAt: windowStartedAt || null, eventLoop: readHistogram() },
    samples: samples.map(sample => ({ ...sample, eventLoop: { ...sample.eventLoop }, memory: { ...sample.memory },
      system: { ...sample.system, loadAverage: [...sample.system.loadAverage] }, gc: { ...sample.gc }, activeOperationIds: [...sample.activeOperationIds] })),
    watchdog: getPerformanceWatchdogDiagnostics(),
    recentGc: gcEvents.map(event => ({ ...event })),
  };
}

/** Legacy API: reads never reset diagnostic windows (the sampler owns resets). */
export function sampleEventLoopLagMs(_reset = true): number {
  if (!histogram) return 0;
  const current = readHistogram();
  return current.count ? current.meanMs : samples.at(-1)?.eventLoop.meanMs ?? 0;
}

export function logEventLoopLagIfHigh(context: string, thresholdMs = 500): number {
  const lagMs = sampleEventLoopLagMs(false);
  const stats = readHistogram();
  if (lagMs >= thresholdMs || stats.maxMs >= thresholdMs) {
    console.warn(`[GatewayEventLoop] ${context}: mean ${lagMs.toFixed(0)}ms, p95 ${stats.p95Ms.toFixed(0)}ms, max ${stats.maxMs.toFixed(0)}ms`);
  }
  return lagMs;
}
