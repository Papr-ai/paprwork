/**
 * Disk cache for Papr workspaces + namespaces (instant Settings load).
 */

import fs from "node:fs";
import path from "node:path";
import { getPaprBaseDir } from "../../core/utils/paprWorkspace.js";

export interface CachedNamespace {
  id: string;
  name: string;
  environmentType?: string;
}

export interface CachedWorkspace {
  id: string;
  name: string;
  role?: string;
  organizationId?: string;
  organizationName?: string;
  workspaceName?: string;
  defaultNamespaceId?: string;
}

export interface PaprWorkspaceCacheFile {
  version: 2;
  updatedAt: string;
  workspaces: CachedWorkspace[];
  namespacesByOrgId: Record<string, CachedNamespace[]>;
}

const CACHE_FILENAME = "papr-workspace-cache.json";

function getCachePath(): string {
  // Global cache — not per-namespace (getPaprDataDir moves when workspace switches).
  return path.join(getPaprBaseDir(), "data", CACHE_FILENAME);
}

export function readPaprWorkspaceCache(): PaprWorkspaceCacheFile | null {
  try {
    const raw = fs.readFileSync(getCachePath(), "utf8");
    const parsed = JSON.parse(raw) as PaprWorkspaceCacheFile;
    if (parsed.version !== 2 || !Array.isArray(parsed.workspaces)) {
      return null;
    }
    // Dedupe on read too, so caches written by older builds are cleaned up
    // without requiring the user to log out and back in.
    return { ...parsed, workspaces: dedupeCachedWorkspaces(parsed.workspaces) };
  } catch {
    return null;
  }
}

/**
 * Collapse workspaces that resolve to the same org + namespace.
 *
 * Duplicate provisioning (and older builds that created a workspace on every
 * login) can leave several workspace rows pointing at one namespace. They are
 * indistinguishable to the user and make the switcher look broken, so keep the
 * best-named entry per org/namespace pair.
 */
export function dedupeCachedWorkspaces(
  workspaces: CachedWorkspace[],
): CachedWorkspace[] {
  const byScope = new Map<string, CachedWorkspace>();

  for (const workspace of workspaces) {
    // Entries without a namespace are not interchangeable — keep them by id.
    const scopeKey = workspace.defaultNamespaceId
      ? `${workspace.organizationId ?? ""}::${workspace.defaultNamespaceId}`
      : `id::${workspace.id}`;

    const existing = byScope.get(scopeKey);
    if (!existing) {
      byScope.set(scopeKey, workspace);
      continue;
    }

    // Prefer the entry with a real name over "Workspace"/"null"/empty.
    const score = (candidate: CachedWorkspace): number => {
      const name = candidate.name?.trim().toLowerCase();
      if (!name || name === "null" || name === "undefined") return 0;
      if (name === "workspace") return 1;
      return 2;
    };

    if (score(workspace) > score(existing)) {
      byScope.set(scopeKey, workspace);
    }
  }

  return [...byScope.values()];
}

export function writePaprWorkspaceCache(input: {
  workspaces: CachedWorkspace[];
  namespacesByOrgId?: Record<string, CachedNamespace[]>;
}): void {
  const existing = readPaprWorkspaceCache();
  const next: PaprWorkspaceCacheFile = {
    version: 2,
    updatedAt: new Date().toISOString(),
    workspaces: dedupeCachedWorkspaces(input.workspaces),
    namespacesByOrgId: {
      ...(existing?.namespacesByOrgId ?? {}),
      ...(input.namespacesByOrgId ?? {}),
    },
  };

  const dir = path.dirname(getCachePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getCachePath(), JSON.stringify(next, null, 2), "utf8");
}

export function getCachedNamespaces(orgId: string): CachedNamespace[] | null {
  const cache = readPaprWorkspaceCache();
  const list = cache?.namespacesByOrgId?.[orgId];
  return list?.length ? list : null;
}

export function cacheNamespacesForOrg(orgId: string, namespaces: CachedNamespace[]): void {
  writePaprWorkspaceCache({
    workspaces: readPaprWorkspaceCache()?.workspaces ?? [],
    namespacesByOrgId: { [orgId]: namespaces },
  });
}
