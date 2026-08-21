/**
 * Tab metadata fields safe to persist across app restarts (exclude live session state).
 */

import type { Tab } from "../types/tabs";

const TRANSIENT_TAB_METADATA_KEYS = new Set([
  "isStreaming",
  "hasUnread",
  "pendingRefresh",
]);

export function sanitizeTabMetadataForPersistence(
  metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!TRANSIENT_TAB_METADATA_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export interface GatewayPersistedTabRow {
  id: string;
  type: string;
  entityId: string;
  title: string;
  displayMode: "standalone" | "parent" | "child";
  parentTabId: string | null;
  position: number;
  isFavorite: boolean;
  createdAt: string;
  lastAccessedAt: string;
  metadata?: Record<string, unknown>;
}

export function serializeTabForGatewayPersistence(
  tab: Pick<
    Tab,
    | "id"
    | "type"
    | "entityId"
    | "title"
    | "displayMode"
    | "parentTabId"
    | "isFavorite"
    | "metadata"
  >,
  index: number,
): GatewayPersistedTabRow {
  const metadata = sanitizeTabMetadataForPersistence(tab.metadata);
  const now = new Date().toISOString();
  return {
    id: tab.id,
    type: tab.type,
    entityId: tab.entityId,
    title: tab.title,
    displayMode: tab.displayMode,
    parentTabId: tab.parentTabId,
    position: index,
    isFavorite: tab.isFavorite ?? false,
    createdAt: now,
    lastAccessedAt: now,
    ...(metadata ? { metadata } : {}),
  };
}
