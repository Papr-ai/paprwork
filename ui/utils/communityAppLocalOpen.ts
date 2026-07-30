import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";

export interface CloudLineageIndex {
  byAppId: Record<string, { sourceAppId: string; sourceSlug: string; sourceNamespaceId: string }>;
  bySourceKey: Record<string, string[]>;
}

export function cloudSourceKey(namespaceId: string, slug: string): string {
  return `${namespaceId}:${slug}`;
}

/** Local Paprwork app id to open for a catalog entry (publisher copy or installed fork). */
export function resolveLocalAppIdForCatalogEntry(
  entry: CommunityCatalogEntry,
  installedAppIds: ReadonlySet<string>,
  lineageIndex: CloudLineageIndex | null,
): string | null {
  if (!entry.appId) return null;

  if (installedAppIds.has(entry.appId)) {
    return entry.appId;
  }

  // Catalog marks owned from apps.json; My Apps may hide the same app when workspace
  // assignment does not match the active namespace filter.
  if (entry.isOwned) {
    return entry.appId;
  }

  if (!entry.namespaceId || !entry.slug || !lineageIndex) {
    return null;
  }

  const forks = lineageIndex.bySourceKey[cloudSourceKey(entry.namespaceId, entry.slug)];
  for (const forkId of forks ?? []) {
    if (installedAppIds.has(forkId)) {
      return forkId;
    }
  }

  return null;
}

export function canInstallCloudCatalogEntry(
  entry: CommunityCatalogEntry,
  localAppId: string | null,
): boolean {
  return entry.codeInstallable && localAppId === null;
}
