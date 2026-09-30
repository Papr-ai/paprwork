/**
 * Reachability cache for Plan A replica path — marks offline after failed Turso contact.
 */

const DEFAULT_OFFLINE_MS = 30_000;

let offlineUntilMs = 0;
let lastReachableAtMs = 0;

function isNetworkLikeError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("socket") ||
    lower.includes("host not found")
  );
}

export function markTursoReplicaReachable(): void {
  const wasOffline = Date.now() < offlineUntilMs;
  offlineUntilMs = 0;
  lastReachableAtMs = Date.now();
  if (
    wasOffline &&
    process.env.VITEST === "true" &&
    process.env.PAPR_TURSO_REPLICA_TEST_DRAIN !== "1"
  ) {
    return;
  }
  if (wasOffline) {
    void import("../services/tursoReplica/tursoReplicaReconnect.js").then(
      ({ drainReplicaDbsOnReconnect }) => drainReplicaDbsOnReconnect(),
    );
  }
}

export function markTursoReplicaUnreachable(options?: {
  durationMs?: number;
  reason?: string;
}): void {
  const durationMs = options?.durationMs ?? DEFAULT_OFFLINE_MS;
  offlineUntilMs = Math.max(offlineUntilMs, Date.now() + durationMs);
  if (options?.reason) {
    console.warn(
      `[TursoReplica] Marking offline for ${durationMs}ms: ${options.reason.slice(0, 120)}`,
    );
  }
}

export function noteTursoReplicaTransportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (isNetworkLikeError(message)) {
    markTursoReplicaUnreachable({ reason: message });
  }
}

export function isTursoReplicaReachable(): boolean {
  return Date.now() >= offlineUntilMs;
}

export function tursoReplicaConnectivitySnapshot(): {
  reachable: boolean;
  offlineUntilMs: number;
  lastReachableAtMs: number;
} {
  return {
    reachable: isTursoReplicaReachable(),
    offlineUntilMs,
    lastReachableAtMs,
  };
}

export function resetTursoReplicaConnectivityForTests(): void {
  offlineUntilMs = 0;
  lastReachableAtMs = 0;
}
