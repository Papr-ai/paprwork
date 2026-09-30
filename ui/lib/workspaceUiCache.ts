/**
 * In-memory per-workspace UI cache for instant org/namespace switches.
 * Shows last-known tabs and apps while gateway reinitializes in the background.
 */

import type { Artifact } from "../stores/artifactsStore";
import type { PersistedAppStateSnapshot } from "./persistedAppState";

export interface WorkspaceUiCacheEntry {
  tabs: PersistedAppStateSnapshot["tabs"];
  activeTabId: string | null;
  splitRatio: number;
  splitRatios: Record<string, number>;
  history: string[];
  historyIndex: number;
  artifacts: Artifact[];
  cachedAt: number;
}

const cache = new Map<string, WorkspaceUiCacheEntry>();

/** Stable key for org + namespace (matches gateway workspace pointer). */
export function buildWorkspaceUiCacheKey(
  organizationId: string,
  namespaceId: string,
): string {
  return `${organizationId}:${namespaceId}`;
}

/** Parse a workspace UI cache key back into org + namespace ids. */
export function parseWorkspaceUiCacheKey(
  key: string,
): { organizationId: string; namespaceId: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator >= key.length - 1) {
    return null;
  }
  const organizationId = key.slice(0, separator);
  const namespaceId = key.slice(separator + 1);
  if (!organizationId || !namespaceId) {
    return null;
  }
  return { organizationId, namespaceId };
}

let activeWorkspaceKey: string | null = null;

export function getActiveWorkspaceUiCacheKey(): string | null {
  return activeWorkspaceKey;
}

export function setActiveWorkspaceUiCacheKey(key: string | null): void {
  activeWorkspaceKey = key;
}

export function readWorkspaceUiCache(
  key: string,
): WorkspaceUiCacheEntry | undefined {
  return cache.get(key);
}

export function writeWorkspaceUiCache(
  key: string,
  entry: Omit<WorkspaceUiCacheEntry, "cachedAt">,
): void {
  cache.set(key, { ...entry, cachedAt: Date.now() });
}

export function clearWorkspaceUiCacheForTests(): void {
  cache.clear();
  activeWorkspaceKey = null;
}
