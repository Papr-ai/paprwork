/**
 * Blocks tab persistence while the saved tab bar for the active workspace has
 * not been read back from SQLite.
 *
 * `AppStateStorage.saveTabs` is `DELETE FROM tabs` followed by re-insert, so
 * persisting a tab bar that was assembled *without* the saved rows replaces them
 * permanently. The renderer clears the tab store at the start of a workspace
 * reload and then restores from SQLite, so between those two points the store
 * holds only whatever scaffolding was added in the meantime — a Settings tab, a
 * landing tab. If the restore cannot read SQLite, that scaffolding is what gets
 * saved, and the real tab bar is gone.
 *
 * The distinction that matters is *read succeeded* versus *read failed*, not
 * *result was empty*: a workspace with no saved tabs and a workspace whose tabs
 * could not be read produce an identical in-memory state, and a user who closes
 * every tab legitimately produces the same one again. Only the read outcome can
 * tell them apart, which is why emptiness is never used as the signal.
 */

/** Outcome of reading a workspace's saved tab bar. */
export type WorkspaceTabReadOutcome =
  | { status: "loaded"; tabCount: number }
  | { status: "unreadable" };

/**
 * Whether the tab bar produced by a restore may be written back over SQLite.
 *
 * `loaded` with `tabCount: 0` is a real answer — the workspace has no saved
 * tabs — and must stay writable, or a genuinely empty workspace could never
 * persist its first tab.
 */
export function shouldBlockTabPersistence(outcome: WorkspaceTabReadOutcome): boolean {
  return outcome.status === "unreadable";
}

let blockedReason: string | null = null;

/**
 * Suspend tab persistence until a successful read clears it.
 *
 * Deliberately has no timeout: a block that expires on its own would restore
 * exactly the failure it exists to prevent, just later and harder to trace.
 */
export function blockTabPersistence(reason: string): void {
  if (blockedReason === reason) {
    return;
  }
  blockedReason = reason;
  console.warn(
    `[Persistence] Tab saves suspended — ${reason}. The saved tab bar is left untouched until it can be read.`,
  );
}

/** Re-enable tab persistence after a successful read of the saved tab bar. */
export function allowTabPersistence(): void {
  if (blockedReason === null) {
    return;
  }
  console.log("[Persistence] Tab saves resumed — saved tab bar read successfully");
  blockedReason = null;
}

export function isTabPersistenceBlocked(): boolean {
  return blockedReason !== null;
}

export function getTabPersistenceBlockReason(): string | null {
  return blockedReason;
}

/** Test hook — reset the latch between unit tests. */
export function resetTabPersistenceGuardForTests(): void {
  blockedReason = null;
}
