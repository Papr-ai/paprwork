/**
 * Snapshot chokidar / watcher-backed resources before and after workspace switch.
 */

import { getAppService } from "./AppService.js";
import { getCloudSyncService } from "./CloudSyncService.js";
import { getCodeIndexingStatus } from "./CodeIndexingService.js";
import { getOpenFdCount } from "./FdWatchdog.js";
import { isTursoLinkedDbWatcherActive } from "./TursoLinkedDbWatcher.js";

export interface WatcherResourceSnapshot {
  timestamp: string;
  appServiceWatchers: number;
  cloudSyncWatcher: boolean;
  tursoLinkedDbWatcher: boolean;
  codeIndexingActive: boolean;
  openFdCount: number | null;
}

export function captureWatcherResourceSnapshot(): WatcherResourceSnapshot {
  let appServiceWatchers = 0;
  try {
    appServiceWatchers = getAppService().getActiveWatcherCount();
  } catch {
    appServiceWatchers = 0;
  }

  const cloudSync = getCloudSyncService();

  return {
    timestamp: new Date().toISOString(),
    appServiceWatchers,
    cloudSyncWatcher: cloudSync?.hasActiveWatcher() ?? false,
    tursoLinkedDbWatcher: isTursoLinkedDbWatcherActive(),
    codeIndexingActive: getCodeIndexingStatus().enabled,
    openFdCount: getOpenFdCount(),
  };
}

export function formatWatcherResourceSnapshot(
  label: string,
  snapshot: WatcherResourceSnapshot,
): string {
  const fd =
    snapshot.openFdCount === null ? "n/a" : String(snapshot.openFdCount);
  return (
    `[WorkspaceSwitch] ${label}: ` +
    `appWatchers=${snapshot.appServiceWatchers}, ` +
    `cloudSync=${snapshot.cloudSyncWatcher ? "on" : "off"}, ` +
    `tursoDb=${snapshot.tursoLinkedDbWatcher ? "on" : "off"}, ` +
    `codeIndex=${snapshot.codeIndexingActive ? "on" : "off"}, ` +
    `openFds=${fd}`
  );
}

export function logWatcherResourceSnapshot(
  label: string,
  snapshot: WatcherResourceSnapshot,
): void {
  console.log(formatWatcherResourceSnapshot(label, snapshot));
}

/** Warn when watchers or fds did not drain after a switch reset. */
export function warnIfWatchersLeaked(
  before: WatcherResourceSnapshot,
  after: WatcherResourceSnapshot,
): void {
  const leaks: string[] = [];

  if (after.appServiceWatchers > 0) {
    leaks.push(`AppService watchers=${after.appServiceWatchers}`);
  }
  if (after.cloudSyncWatcher) {
    leaks.push("CloudSync watcher still active");
  }
  if (after.tursoLinkedDbWatcher) {
    leaks.push("Turso linked-db watcher still active");
  }
  if (after.codeIndexingActive) {
    leaks.push("Code indexing watcher still active");
  }

  if (leaks.length === 0) {
    console.log("[WorkspaceSwitch] Watcher audit: all path-bound watchers stopped");
    return;
  }

  console.warn(
    `[WorkspaceSwitch] Watcher audit: possible leak after switch ` +
      `(before appWatchers=${before.appServiceWatchers}, after=${after.appServiceWatchers}): ` +
      leaks.join("; "),
  );
}
