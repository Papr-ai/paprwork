import type { Tab } from "../types/tabs";

/** Max app preview iframes kept in memory when only one pane is visible. */
export const MAX_MOUNTED_APP_PREVIEWS = 7;

/** Never cap below visible panes + one warm hidden tab (standalone full-pane view). */
export function effectiveMaxMountedAppPreviews(visibleAppTabCount: number): number {
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
