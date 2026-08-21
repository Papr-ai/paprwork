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

  // Publisher copy — always open the local mini-app (same id as cloud publish).
  // Do not gate on the artifacts cache; it can lag behind app:list on Community mount.
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
  if (!entry.codeInstallable || entry.isOwned) {
    return false;
  }
  return localAppId === null;
}

/** Open local mini-app tab when a publisher copy or installed fork exists on disk. */
export function shouldOpenCatalogEntryLocally(
  entry: CommunityCatalogEntry,
  installedAppIds: ReadonlySet<string>,
  lineageIndex: CloudLineageIndex | null,
): boolean {
  return resolveLocalAppIdForCatalogEntry(entry, installedAppIds, lineageIndex) !== null;
}
