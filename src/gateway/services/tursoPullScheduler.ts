/**
 * Debounced cloud→local Turso pull when user opens a mini-app (local preview).
 * Mirrors push-side watcher pattern — event-triggered, not periodic polling.
 *
 * App-open reconcile waits for first successful mini-app DB read (data paint)
 * so the per-DB replica lane is not held by pull during initial load.
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
/** After gateway boot, defer app-open pulls so the first restored app stays responsive. */
const DEFAULT_STARTUP_GRACE_MS = 8_000;
/** If the app never hits /api/db/*, still reconcile eventually (static / no linked reads). */
const DEFAULT_FIRST_PAINT_MAX_WAIT_MS = 120_000;

let gatewayStartedAtMs = Date.now();

const appOpenTimers = new Map<string, NodeJS.Timeout>();
const appOpenInFlight = new Set<string>();
const appOpenLastReconciledAt = new Map<string, number>();
const dbIdPullInFlight = new Set<string>();

/** Registered on index.html; debounced flush starts after first data read or max wait. */
const pendingFirstPaint = new Map<string, { maxWaitTimer: NodeJS.Timeout }>();

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

function startupGraceMs(): number {
  const raw = process.env.TURSO_PULL_STARTUP_GRACE_MS;
  if (!raw) {
    return DEFAULT_STARTUP_GRACE_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_STARTUP_GRACE_MS;
}

function firstPaintMaxWaitMs(): number {
  const raw = process.env.TURSO_PULL_FIRST_PAINT_MAX_WAIT_MS?.trim();
  if (!raw) {
    return DEFAULT_FIRST_PAINT_MAX_WAIT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_FIRST_PAINT_MAX_WAIT_MS;
}

function clearPendingFirstPaint(appId: string): void {
  const pending = pendingFirstPaint.get(appId);
  if (pending) {
    clearTimeout(pending.maxWaitTimer);
    pendingFirstPaint.delete(appId);
  }
}

function beginAppOpenPullDebounce(appId: string): void {
  clearPendingFirstPaint(appId);

  const existing = appOpenTimers.get(appId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    appOpenTimers.delete(appId);
    void flushTursoPullForAppOpen(appId);
  }, debounceMs());

  appOpenTimers.set(appId, timer);
  console.log(
    `[TursoPullScheduler] App-open pull debounced for app ${appId} (${debounceMs()}ms)`,
  );
}

/** Mark gateway boot time — app-open pulls are suppressed briefly after this. */
export function markTursoPullSchedulerGatewayBoot(): void {
  gatewayStartedAtMs = Date.now();
}

/**
 * Register intent to reconcile when the user opens a mini-app. Does not touch
 * the replica lane until {@link notifyMiniAppFirstDataPaint} or max-wait fires.
 */
export function scheduleTursoPullForAppOpen(appId: string): void {
  const bridge = getTursoSyncBridge();
  if (!bridge?.enabled) {
    return;
  }

  const trimmed = appId.trim();
  if (!trimmed) {
    return;
  }

  const grace = startupGraceMs();
  if (grace > 0 && Date.now() - gatewayStartedAtMs < grace) {
    return;
  }

  const lastAt = appOpenLastReconciledAt.get(trimmed);
  if (lastAt !== undefined && Date.now() - lastAt < cooldownMs()) {
    return;
  }

  clearPendingFirstPaint(trimmed);

  const maxWait = firstPaintMaxWaitMs();
  const maxWaitTimer = setTimeout(() => {
    console.log(
      `[TursoPullScheduler] App-open pull max-wait (${maxWait}ms) for app ${trimmed} — no DB read signal`,
    );
    beginAppOpenPullDebounce(trimmed);
  }, maxWait);

  pendingFirstPaint.set(trimmed, { maxWaitTimer });
  console.log(
    `[TursoPullScheduler] App-open pull pending first data paint for app ${trimmed} ` +
      `(max wait ${maxWait}ms)`,
  );
}

/**
 * Call after the mini-app's first successful read batch/query — initial UI data
 * is on screen; safe to debounce cloud→local reconcile.
 */
export function notifyMiniAppFirstDataPaint(appId: string): void {
  const trimmed = appId.trim();
  if (!trimmed || !pendingFirstPaint.has(trimmed)) {
    return;
  }
  console.log(
    `[TursoPullScheduler] First data paint for app ${trimmed} — scheduling app-open pull`,
  );
  beginAppOpenPullDebounce(trimmed);
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
  for (const pending of pendingFirstPaint.values()) {
    clearTimeout(pending.maxWaitTimer);
  }
  pendingFirstPaint.clear();
  appOpenInFlight.clear();
  appOpenLastReconciledAt.clear();
  dbIdPullInFlight.clear();
  gatewayStartedAtMs = Date.now();
}
