/**
 * Timing logs for GET /api/sync/items (correlates with event-loop lag).
 */

import { sampleEventLoopLagMs } from "../services/gatewayEventLoopMonitor.js";
import { PhaseTimer } from "./phaseTiming.js";

export interface SyncItemsRouteFinish {
  appId?: string;
  forceRefresh: boolean;
  tursoCached: boolean;
  responseCached?: boolean;
}

function readSlowThresholdMs(): number {
  const raw = process.env.SYNC_ITEMS_SLOW_MS?.trim();
  if (!raw) {
    return 500;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function traceAll(): boolean {
  return process.env.SYNC_ITEMS_TRACE === "1";
}

export function shouldLogSyncItemsRoute(totalMs: number): boolean {
  return traceAll() || totalMs >= readSlowThresholdMs();
}

export function createSyncItemsRouteTimer(): PhaseTimer {
  return new PhaseTimer();
}

export function logSyncItemsRoute(
  timer: PhaseTimer,
  finish: SyncItemsRouteFinish,
): void {
  const totalMs = timer.totalMs();
  if (!shouldLogSyncItemsRoute(totalMs)) {
    return;
  }
  const lagMs = sampleEventLoopLagMs(false);
  const app = finish.appId ?? "all";
  const responseCached =
    finish.responseCached === true ? " responseCached=true" : "";
  console.log(
    `[SyncItems] ${totalMs}ms appId=${app} refresh=${finish.forceRefresh} tursoCached=${finish.tursoCached}${responseCached} eventLoopLagMs=${lagMs} — ${timer.formatPhases()}`,
  );
}
