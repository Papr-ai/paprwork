/**
 * Coalesce routine tab saves off the WebSocket hot path so app:save_tabs returns immediately.
 * Pending writes capture workspace write generation and are dropped after org switch.
 */

import {
  getAppStateStorage,
  type TabMetadata,
} from "./AppStateStorage.js";
import { getWorkspaceWriteGeneration } from "../workspaceWriteGuard.js";

let pendingTabs: TabMetadata[] | null = null;
let pendingGeneration = 0;
let flushScheduled = false;

function writePendingTabs(): void {
  const tabs = pendingTabs;
  const generation = pendingGeneration;
  pendingTabs = null;
  pendingGeneration = 0;
  flushScheduled = false;
  if (!tabs) {
    return;
  }

  if (generation !== getWorkspaceWriteGeneration()) {
    console.log(
      "[deferredTabSave] Dropped stale tab save (workspace generation changed)",
    );
    return;
  }

  const started = performance.now();
  getAppStateStorage().saveTabs(tabs);
  const elapsedMs = Math.round(performance.now() - started);
  if (elapsedMs >= 50) {
    console.log(
      `[AppStateStorage] deferred saveTabs ${tabs.length} tab(s) in ${elapsedMs}ms`,
    );
  }
}

export function scheduleDeferredTabSave(tabs: TabMetadata[]): void {
  pendingTabs = tabs;
  pendingGeneration = getWorkspaceWriteGeneration();
  if (flushScheduled) {
    return;
  }
  flushScheduled = true;
  setImmediate(writePendingTabs);
}

/** Drop in-flight tab saves when leaving a workspace — do not flush to the next org. */
export function discardDeferredTabSave(reason: string): void {
  if (pendingTabs) {
    console.log(`[deferredTabSave] Discarded pending tab save (${reason})`);
  }
  pendingTabs = null;
  pendingGeneration = 0;
  flushScheduled = false;
}

/** Test-only reset. */
export function resetDeferredTabSaveForTests(): void {
  pendingTabs = null;
  pendingGeneration = 0;
  flushScheduled = false;
}
