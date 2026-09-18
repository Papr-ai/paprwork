import type { Tab } from "../types/tabs";

/**
 * Max app preview iframes kept in memory when only one pane is visible.
 *
 * Two numbers, because a warm hidden preview does not cost the same thing in
 * both hosting modes:
 *
 * - **Isolated** (per-app origin, own renderer process): a warm tab costs
 *   memory and a process. It cannot touch the chat UI's main thread, so 7 is
 *   affordable and buys instant tab switches.
 * - **Shared** (one origin, one process): a warm tab costs *the chat UI's main
 *   thread*. `display: none` stops rAF but not timers, promise continuations
 *   or fetch callbacks — a hidden preview polling on an interval runs at full
 *   rate, on our thread. Seven of those is the measured pathology (renderer
 *   pegged at ~120% CPU with the UI unresponsive), so the shared path keeps
 *   one warm tab and reloads the rest.
 *
 * See docs/MINI_APP_PROCESS_ISOLATION.md.
 */
export const MAX_MOUNTED_APP_PREVIEWS = 7;

/** Shared-origin cap: every extra warm preview is contention on our own thread. */
export const MAX_MOUNTED_APP_PREVIEWS_SHARED_ORIGIN = 2;

/** Never cap below visible panes + one warm hidden tab (standalone full-pane view). */
export function effectiveMaxMountedAppPreviews(
  visibleAppTabCount: number,
  isolated = true,
): number {
  const base = isolated
    ? MAX_MOUNTED_APP_PREVIEWS
    : MAX_MOUNTED_APP_PREVIEWS_SHARED_ORIGIN;
  return Math.max(base, visibleAppTabCount + 1);
}

export interface SelectMountedAppTabOptions {
  maxMounted?: number;
  /** Split/merged view: mount only apps in visible panes (no LRU warm hidden). */
  visibleOnly?: boolean;
  /**
   * Are previews served from per-app origins?
   *
   * Defaults true so an explicit `maxMounted` still means what it says; the
   * caller passes the real answer.
   */
  isolatedOrigins?: boolean;
}

function resolveMountOptions(
  maxMountedOrOptions?: number | SelectMountedAppTabOptions,
): SelectMountedAppTabOptions {
  if (typeof maxMountedOrOptions === "number") {
    return { maxMounted: maxMountedOrOptions };
  }
  return maxMountedOrOptions ?? {};
}

/**
 * LRU selection for which app preview tabs stay mounted.
 * Eviction unmounts the iframe (full reload on return) — the only memory bound.
 */
export function selectMountedAppTabIds(
  appTabs: readonly Tab[],
  visibleTabIds: ReadonlySet<string>,
  lastActiveAt: ReadonlyMap<string, number>,
  maxMountedOrOptions?: number | SelectMountedAppTabOptions,
): Set<string> {
  const options = resolveMountOptions(maxMountedOrOptions);
  const visibleAppIds = appTabs
    .filter((tab) => visibleTabIds.has(tab.id))
    .map((tab) => tab.id);

  if (options.visibleOnly) {
    return new Set(visibleAppIds);
  }

  const cap =
    options.maxMounted ??
    effectiveMaxMountedAppPreviews(
      visibleAppIds.length,
      options.isolatedOrigins ?? true,
    );
  const slotsForHidden = Math.max(0, cap - visibleAppIds.length);

  const hiddenKeepIds = appTabs
    .filter((tab) => !visibleTabIds.has(tab.id))
    .sort(
      (a, b) =>
        (lastActiveAt.get(b.id) ?? 0) - (lastActiveAt.get(a.id) ?? 0),
    )
    .slice(0, slotsForHidden)
    .map((tab) => tab.id);

  return new Set([...visibleAppIds, ...hiddenKeepIds]);
}
