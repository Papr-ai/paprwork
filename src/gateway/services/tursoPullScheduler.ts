/**
 * Debounced cloud→local Turso pull when user opens a mini-app (local preview).
 * Mirrors push-side watcher pattern — event-triggered, not periodic polling.
 */

import { getTursoSyncBridge } from "./TursoSyncBridge.js";
import { reconcileLinkedSourcesFromCloud } from "./tursoSyncSession.js";

const DEFAULT_APP_OPEN_DEBOUNCE_MS = 3_000;

const appOpenTimers = new Map<string, NodeJS.Timeout>();
const appOpenInFlight = new Set<string>();

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
  } catch (error) {
    console.warn(
      `[TursoPullScheduler] App-open pull failed for ${appId}:`,
      (error as Error).message.slice(0, 120),
    );
  } finally {
    appOpenInFlight.delete(appId);
  }
}

/** Test hook — reset debounce timers. */
export function resetTursoPullSchedulerForTests(): void {
  for (const timer of appOpenTimers.values()) {
    clearTimeout(timer);
  }
  appOpenTimers.clear();
  appOpenInFlight.clear();
}
