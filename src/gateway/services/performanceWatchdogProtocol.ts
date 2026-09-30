import type { DatabaseDiagnosticCollector } from "./databaseDiagnostics/collector.js";
import type { collectHostMeasurements, captureNativeStack } from "./performanceWatchdogMetrics.js";
export type HostSample = Awaited<ReturnType<typeof collectHostMeasurements>> & {
  vmCounterRatesPerSecond: Record<string, number | null> | null;
  vmRateIntervalMs: number | null;
};
export interface StallEvidence {
  detectedAt: string; heartbeatAgeMs: number; lastKnownOperationIds: string[];
  stack: Awaited<ReturnType<typeof captureNativeStack>> | { status: "collecting" };
  stackFinishedAt?: string;
  databaseEvidence?: ReturnType<DatabaseDiagnosticCollector["evidence"]>;
  nativeDatabaseLockWait?: boolean;
}
export interface WatchdogSnapshot {
  capturedAt: string; pid: number; gatewayPid: number;
  samples: HostSample[]; stalls: StallEvidence[];
  observerGaps: Array<{ detectedAt: string; durationMs: number }>;
  heartbeatAgeMs: number | null;
  collectionFailures: number;
  databases?: ReturnType<DatabaseDiagnosticCollector["snapshot"]>;
}
export type WatchdogParentMessage = { type: "heartbeat"; operationIds: string[] } | { type: "snapshot" };
export type WatchdogChildMessage = { type: "ready" } | { type: "snapshot"; snapshot: WatchdogSnapshot };
