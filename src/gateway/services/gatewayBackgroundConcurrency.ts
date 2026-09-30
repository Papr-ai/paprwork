/**
 * Device-aware background concurrency and worker pool sizing (Phase D).
 * OS chooses cores; we cap parallel background work and pool sizes.
 */

import os from "node:os";

const MIN_BG_CONCURRENCY = 1;
const MAX_BG_CONCURRENCY = 4;

function readEnvInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.floor(parsed);
}

/** Parallel coalesced background tasks (distinct task keys in flight). */
export function resolveGatewayBackgroundMaxConcurrency(): number {
  const override = readEnvInt("GATEWAY_BG_MAX_CONCURRENCY");
  if (override !== undefined) {
    return Math.max(
      MIN_BG_CONCURRENCY,
      Math.min(MAX_BG_CONCURRENCY, override),
    );
  }
  const cpus = os.cpus().length;
  const derived = cpus > 1 ? cpus - 1 : 1;
  return Math.max(MIN_BG_CONCURRENCY, Math.min(MAX_BG_CONCURRENCY, derived));
}

/** Mini-app SQLite worker-thread pool size. */
export function resolveDbQueryPoolSize(): number {
  const override = readEnvInt("DB_QUERY_POOL_SIZE");
  if (override !== undefined) {
    return Math.max(1, Math.min(8, override));
  }
  const bg = resolveGatewayBackgroundMaxConcurrency();
  return Math.max(1, Math.min(4, bg));
}

/** Code index file-read worker pool size. */
export function resolveCodeIndexIoPoolSize(): number {
  const override = readEnvInt("CODE_INDEX_IO_POOL_SIZE");
  if (override !== undefined) {
    return Math.max(1, Math.min(8, override));
  }
  const bg = resolveGatewayBackgroundMaxConcurrency();
  return Math.max(1, Math.min(4, bg));
}

export function isGatewayBackgroundProcessEnabled(): boolean {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return false;
  }
  const raw = process.env.GATEWAY_BACKGROUND_PROCESS?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") {
    return false;
  }
  return true;
}

/**
 * Task keys executed in the background child process (Phase C).
 * Vault full-sync tasks stay in the gateway parent so they share {@link VaultSyncService.runFullSync}
 * with {@link VaultSyncService.initialize} — the child only ran HTTP push and duplicated startup sync.
 */
export const GATEWAY_BACKGROUND_CHILD_TASKS = new Set<string>([]);
