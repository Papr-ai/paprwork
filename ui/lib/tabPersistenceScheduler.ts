/**
 * Coalesces rapid tab-structure saves into one gateway write.
 * Prevents back-to-back save_tabs when switching tabs quickly.
 */

const TAB_SAVE_DEBOUNCE_MS = 800;
const TAB_SAVE_TRAILING_MS = 400;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight = false;
let savePending = false;
let coalescedCount = 0;

export function getTabSaveDebounceMs(): number {
  return TAB_SAVE_DEBOUNCE_MS;
}

export function scheduleTabStructureSave(
  saveFn: () => Promise<void>,
  reason: string,
): void {
  coalescedCount += 1;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const skipped = coalescedCount - 1;
    coalescedCount = 0;
    if (skipped > 0) {
      console.log(
        `[Persistence] Coalesced ${skipped} tab save request(s) before flush (${reason})`,
      );
    }
    void runTabSave(saveFn, reason);
  }, TAB_SAVE_DEBOUNCE_MS);
}

async function runTabSave(
  saveFn: () => Promise<void>,
  reason: string,
): Promise<void> {
  if (saveInFlight) {
    savePending = true;
    return;
  }

  saveInFlight = true;
  const started = performance.now();
  try {
    console.log(`[Persistence] Saving tabs to SQLite (${reason})...`);
    await saveFn();
    const elapsed = (performance.now() - started).toFixed(2);
    console.log(`[Persistence] Tab save finished in ${elapsed}ms (${reason})`);
  } catch (error) {
    console.error("[Persistence] Tab save failed:", error);
    throw error;
  } finally {
    saveInFlight = false;
    if (savePending) {
      savePending = false;
      setTimeout(() => {
        void runTabSave(saveFn, `${reason}-trailing`);
      }, TAB_SAVE_TRAILING_MS);
    }
  }
}

/** Test-only reset. */
export function resetTabPersistenceSchedulerForTests(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  saveInFlight = false;
  savePending = false;
  coalescedCount = 0;
}
