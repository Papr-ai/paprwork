/**
 * Timing logs for mini-app static hosting (/apps/:id/...).
 * Correlates handler time with event-loop lag (same signal as websocket_ping).
 */

import { sampleEventLoopLagMs } from "../services/gatewayEventLoopMonitor.js";

export interface MiniAppStaticServeFinish {
  appId: string;
  requestedPath: string;
  statusCode: number;
  byteLength?: number;
}

export interface MiniAppStaticServeTimer {
  markPhase(phase: string, atMs?: number): void;
  finishIfNeeded(finish: MiniAppStaticServeFinish): void;
}

const KEY_PATHS = new Set([
  "index.html",
  "dist/app.js",
  "dist/app.css",
]);

function readSlowThresholdMs(): number {
  const raw = process.env.MINI_APP_STATIC_SLOW_MS?.trim();
  if (!raw) {
    return 500;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function traceAllPaths(): boolean {
  return process.env.MINI_APP_STATIC_TRACE === "1";
}

export function shouldLogMiniAppStaticServe(
  requestedPath: string,
  totalMs: number,
): boolean {
  if (traceAllPaths()) {
    return true;
  }
  if (KEY_PATHS.has(requestedPath)) {
    return true;
  }
  return totalMs >= readSlowThresholdMs();
}

export function createMiniAppStaticServeTimer(
  receivedAt: number,
): MiniAppStaticServeTimer {
  const phases = new Map<string, number>();
  const eventLoopLagAtReceiveMs = sampleEventLoopLagMs(false);

  return {
    markPhase(phase: string, atMs?: number): void {
      const anchor = atMs ?? performance.now();
      phases.set(phase, anchor - receivedAt);
    },
    finishIfNeeded(finish: MiniAppStaticServeFinish): void {
      const totalMs = performance.now() - receivedAt;
      if (!shouldLogMiniAppStaticServe(finish.requestedPath, totalMs)) {
        return;
      }

      const parts: string[] = [
        `total=${totalMs.toFixed(0)}ms`,
        `status=${finish.statusCode}`,
      ];
      if (finish.byteLength !== undefined) {
        parts.push(`bytes=${finish.byteLength}`);
      }
      parts.push(`eventLoopLagMs=${eventLoopLagAtReceiveMs.toFixed(0)}`);

      for (const [name, ms] of phases) {
        parts.push(`${name}=${ms.toFixed(0)}ms`);
      }

      console.log(
        `[MiniAppStatic] app=${finish.appId} path=${finish.requestedPath} ${parts.join(" ")}`,
      );
    },
  };
}
