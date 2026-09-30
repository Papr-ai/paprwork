/**
 * Gateway cold-start timing — one row per step, summary sorted slowest-first.
 * Enable with GATEWAY_STARTUP_TIMING=1
 */

export interface GatewayStartupTimingRow {
  phase: string;
  step: string;
  ms: number;
}

let enabled = process.env.GATEWAY_STARTUP_TIMING === "1";
let bootStartMs = 0;
let routeSectionStartMs = 0;
const rows: GatewayStartupTimingRow[] = [];

function record(phase: string, step: string, ms: number): void {
  if (!enabled) {
    return;
  }
  rows.push({ phase, step, ms });
  console.log(`[GatewayStartup] ${phase} | ${step}: ${ms}ms`);
}

export function isGatewayStartupTimingEnabled(): boolean {
  return enabled;
}

export function beginGatewayStartupTiming(): void {
  enabled = process.env.GATEWAY_STARTUP_TIMING === "1";
  bootStartMs = performance.now();
  rows.length = 0;
  if (enabled) {
    console.log("[GatewayStartup] Timing enabled (GATEWAY_STARTUP_TIMING=1)");
  }
}

export async function timeStartupStep<T>(
  phase: string,
  step: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!enabled) {
    return await fn();
  }
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    record(phase, step, Math.round(performance.now() - t0));
  }
}

export function timeStartupSync<T>(phase: string, step: string, fn: () => T): T {
  if (!enabled) {
    return fn();
  }
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    record(phase, step, Math.round(performance.now() - t0));
  }
}

/** Start measuring Express route registration blocks (sync). */
export function beginRouteRegistrationTiming(): void {
  routeSectionStartMs = performance.now();
}

/** Time since previous route section (or beginRouteRegistrationTiming). */
export function lapRouteRegistrationSection(section: string): void {
  if (!enabled) {
    routeSectionStartMs = performance.now();
    return;
  }
  const now = performance.now();
  record("routes", section, Math.round(now - routeSectionStartMs));
  routeSectionStartMs = now;
}

/** Deferred work that runs after gatewayReady (cloud sync, vault, turso, …). */
export function recordDeferredStartupStep(
  phase: string,
  step: string,
  ms: number,
): void {
  record(phase, step, ms);
}

export function getGatewayStartupTimingRows(): readonly GatewayStartupTimingRow[] {
  return rows;
}

/** Print table sorted by duration (slowest first). Call after gatewayReady. */
export function printGatewayStartupSummary(): void {
  if (!enabled) {
    return;
  }
  const totalMs = Math.round(performance.now() - bootStartMs);
  const sorted = [...rows].sort((a, b) => b.ms - a.ms);

  console.log("[GatewayStartup] ═══════════════════════════════════════════════════════");
  console.log("[GatewayStartup]   ms     phase        step");
  for (const row of sorted) {
    const msCol = String(row.ms).padStart(6);
    console.log(
      `[GatewayStartup] ${msCol}   ${row.phase.padEnd(12)} ${row.step}`,
    );
  }
  console.log(
    `[GatewayStartup] ── ${totalMs}ms total to summary (gatewayReady); deferred steps append below as they run ──`,
  );
}
