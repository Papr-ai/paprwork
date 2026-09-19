import type { Tab } from "../types/tabs";

/**
 * Max app preview iframes kept in memory when only one pane is visible.
 *
 * One number, in both hosting modes. A second, smaller shared-origin cap lived
 * here and was removed: it capped around a mechanism rather than repairing it.
 * A warm hidden preview is only cheap if it is genuinely quiet, and quiet
 * depended on the suspend signal arriving — which the gate could not know at
 * boot, so it defaulted to `visible` and waited for a `postMessage` that raced
 * the app's own module-scope fetch. `iframe.name` is readable synchronously
 * and cross-origin before any app script runs, so the phase is now known at
 * boot with no message and no race.
 *
 * What the gate still does not cover is compute and the non-fetch transports,
 * which on a shared origin run on the chat UI's own thread. Measured across
 * the 57 installed apps that residual is small — 6 use `setInterval`, 2
 * `EventSource`, 1 `WebSocket`, and `requestAnimationFrame` is already paused
 * by the browser when hidden — so 7 is affordable, and the alternative costs a
 * full reload (queries, Turso pulls) on every tab switch, forever.
 *
 * See docs/MINI_APP_PROCESS_ISOLATION.md.
 */
export const MAX_MOUNTED_APP_PREVIEWS = 7;

/** Never cap below visible panes + one warm hidden tab (standalone full-pane view). */
export function effectiveMaxMountedAppPreviews(
  visibleAppTabCount: number,
): number {
  return Math.max(MAX_MOUNTED_APP_PREVIEWS, visibleAppTabCount + 1);
}

export interface SelectMountedAppTabOptions {
  maxMounted?: number;
  /** Split/merged view: mount only apps in visible panes (no LRU warm hidden). */
  visibleOnly?: boolean;
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
    options.maxMounted ?? effectiveMaxMountedAppPreviews(visibleAppIds.length);
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
