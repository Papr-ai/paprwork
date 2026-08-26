/**
 * Community Apps browse filters — prioritize installable / forkable apps.
 */

import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";

/**
 * Community browse hides preview-only cloud apps (live view, no installable source).
 * Owned preview-only shares are hidden too — they are not Community listings.
 */
export function shouldShowInCommunityBrowse(
  entry: CommunityCatalogEntry,
): boolean {
  if (entry.source === "opensource") {
    return true;
  }
  return entry.codeInstallable === true;
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

