/**
 * Stable fingerprint for tab *structure* — excludes transient UI flags (hasUnread, etc.)
 * so switching tabs does not trigger a full SQLite rewrite when nothing persisted changed.
 */

import type { Tab } from "../types/tabs";
import { sanitizeTabMetadataForPersistence } from "./tabPersistenceMetadata";

export function buildTabStructureFingerprint(tabs: readonly Tab[]): string {
  return JSON.stringify(
    tabs.map((tab, index) => ({
      id: tab.id,
      type: tab.type,
      entityId: tab.entityId,
      title: tab.title,
      displayMode: tab.displayMode,
      parentTabId: tab.parentTabId ?? null,
      childTabIds: tab.childTabIds ?? [],
      position: index,
      isFavorite: tab.isFavorite ?? false,
      metadata: sanitizeTabMetadataForPersistence(tab.metadata) ?? null,
    })),
  );
}
