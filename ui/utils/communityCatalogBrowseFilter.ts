/**
 * Community Apps browse filters — prioritize installable / forkable apps.
 */

import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";

const SHOW_PREVIEW_ONLY_KEY = "papr-community-show-preview-only";

/** Live cloud apps without installable source (preview / web-only). */
export function isPreviewOnlyCommunityEntry(
  entry: CommunityCatalogEntry,
): boolean {
  return (
    entry.source === "cloud" &&
    entry.liveViewable === true &&
    entry.codeInstallable !== true
  );
}

/**
 * Default Community browse hides preview-only cloud apps.
 * Owned apps stay visible so publishers can open their published copies.
 */
export function shouldShowInCommunityBrowse(
  entry: CommunityCatalogEntry,
  options: { showPreviewOnly: boolean },
): boolean {
  if (options.showPreviewOnly) {
    return true;
  }
  if (entry.isOwned) {
    return true;
  }
  if (entry.source === "opensource") {
    return true;
  }
  return entry.codeInstallable === true;
}

export function countHiddenPreviewOnlyCommunityEntries(
  entries: readonly CommunityCatalogEntry[],
): number {
  return entries.filter(
    (entry) => isPreviewOnlyCommunityEntry(entry) && !entry.isOwned,
  ).length;
}

/** Installable / forkable entries first when mixed lists are shown. */
export function sortCommunityEntriesInstallableFirst(
  entries: readonly CommunityCatalogEntry[],
): CommunityCatalogEntry[] {
  return [...entries].sort((left, right) => {
    const leftInstallable =
      left.codeInstallable === true || left.source === "opensource";
    const rightInstallable =
      right.codeInstallable === true || right.source === "opensource";
    if (leftInstallable === rightInstallable) {
      return left.name.localeCompare(right.name);
    }
    return leftInstallable ? -1 : 1;
  });
}

export function readCommunityShowPreviewOnlyPreference(): boolean {
  try {
    return sessionStorage.getItem(SHOW_PREVIEW_ONLY_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeCommunityShowPreviewOnlyPreference(show: boolean): void {
  try {
    if (show) {
      sessionStorage.setItem(SHOW_PREVIEW_ONLY_KEY, "true");
    } else {
      sessionStorage.removeItem(SHOW_PREVIEW_ONLY_KEY);
    }
  } catch {
    /* noop */
  }
}
