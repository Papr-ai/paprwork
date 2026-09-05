/**
 * Debounced cloud→local Turso pull when user opens a mini-app (local preview).
 * Mirrors push-side watcher pattern — event-triggered, not periodic polling.
 */

import type { AppDataSource } from "./appDataSources.js";
import {
  getDatabaseRegistryService,
  initializeDatabaseRegistry,
} from "./DatabaseRegistryService.js";
import { getTursoSyncBridge } from "./TursoSyncBridge.js";
import { reconcileLinkedSourcesFromCloud } from "./tursoSyncSession.js";
import {
  pullLinkedDbViaTursoReplica,
  shouldUseTursoReplicaForSource,
} from "./tursoReplica/tursoReplicaRouting.js";

const DEFAULT_APP_OPEN_DEBOUNCE_MS = 3_000;
/**
 * Skip app-open reconciles when this app was reconciled recently. Tab focus / keep-alive
 * eviction remounts the preview far more often than cloud data changes, and the
 * sync-index heartbeat + db-changed SSE already keep the replica current between opens.
 */
const DEFAULT_APP_OPEN_COOLDOWN_MS = 60_000;

const appOpenTimers = new Map<string, NodeJS.Timeout>();
const appOpenInFlight = new Set<string>();
const appOpenLastReconciledAt = new Map<string, number>();
const dbIdPullInFlight = new Set<string>();

function cooldownMs(): number {
  const raw = process.env.TURSO_PULL_APP_OPEN_COOLDOWN_MS;
  if (!raw) {
    return DEFAULT_APP_OPEN_COOLDOWN_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_APP_OPEN_COOLDOWN_MS;
}

function debounceMs(): number {
  const raw = process.env.TURSO_PULL_APP_OPEN_DEBOUNCE_MS;
  if (!raw) {
    return DEFAULT_APP_OPEN_DEBOUNCE_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_APP_OPEN_DEBOUNCE_MS;
}

export function scheduleTursoPullForAppOpen(appId: string): void {
  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    return;
  }

  const trimmed = appId.trim();
  if (!trimmed) {
    return;
  }

  const lastAt = appOpenLastReconciledAt.get(trimmed);
  if (lastAt !== undefined && Date.now() - lastAt < cooldownMs()) {
    return;
  }

  const existing = appOpenTimers.get(trimmed);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    appOpenTimers.delete(trimmed);
    void flushTursoPullForAppOpen(trimmed);
  }, debounceMs());

  appOpenTimers.set(trimmed, timer);
  console.log(
    `[TursoPullScheduler] Scheduled cloud→local pull for app ${trimmed} ` +
      `(debounce ${debounceMs()}ms)`,
  );
}

async function flushTursoPullForAppOpen(appId: string): Promise<void> {
  if (appOpenInFlight.has(appId)) {
    return;
  }

  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    return;
  }

  appOpenInFlight.add(appId);
  try {
    await reconcileLinkedSourcesFromCloud(
      bridge,
      { appId },
      { trigger: "app_open" },
    );
    appOpenLastReconciledAt.set(appId, Date.now());
  } catch (error) {
    console.warn(
      `[TursoPullScheduler] App-open pull failed for ${appId}:`,
      (error as Error).message.slice(0, 120),
    );
  } finally {
    appOpenInFlight.delete(appId);
  }
}

/**
 * One-shot cloud→local pull when a mini-app subscribes to db-changed SSE.
 * Event-triggered on SSE connect — not periodic polling.
 */
export function scheduleTursoPullForDbIds(dbIds: readonly string[]): void {
  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    return;
  }

  const unique = [
    ...new Set(dbIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  ];
  if (unique.length === 0) {
    return;
  }

  void flushTursoPullForDbIds(unique);
}

async function flushTursoPullForDbIds(dbIds: string[]): Promise<void> {
  await initializeDatabaseRegistry();
  const registry = getDatabaseRegistryService();

  for (const dbId of dbIds) {
    if (dbIdPullInFlight.has(dbId)) {
      continue;
    }
    dbIdPullInFlight.add(dbId);
    try {
      const record = registry.getById(dbId);
      if (!record || record.status === "tombstone") {
        continue;
      }

      const source: AppDataSource = {
        id: record.dbId,
        type: "sqlite",
        dbId: record.dbId,
        alias: record.label ?? record.dbId,
        dbPath: record.localPath,
        tables: [],
        linkedAt: record.createdAt,
      };

      if (!shouldUseTursoReplicaForSource(source)) {
        continue;
      }

      await pullLinkedDbViaTursoReplica(source);
    } catch (error) {
      console.warn(
        `[TursoPullScheduler] SSE subscribe pull failed for ${dbId}:`,
        (error as Error).message.slice(0, 120),
      );
    } finally {
      dbIdPullInFlight.delete(dbId);
    }
  }
}

/** Test hook — reset debounce timers. */
export function resetTursoPullSchedulerForTests(): void {
  for (const timer of appOpenTimers.values()) {
    clearTimeout(timer);
  }
  appOpenTimers.clear();
  appOpenInFlight.clear();
  appOpenLastReconciledAt.clear();
  dbIdPullInFlight.clear();
}
