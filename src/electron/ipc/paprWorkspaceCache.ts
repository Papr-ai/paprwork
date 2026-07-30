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
    return parsed;
  } catch {
    return null;
  }
}

export function writePaprWorkspaceCache(input: {
  workspaces: CachedWorkspace[];
  namespacesByOrgId?: Record<string, CachedNamespace[]>;
}): void {
  const existing = readPaprWorkspaceCache();
  const next: PaprWorkspaceCacheFile = {
    version: 2,
    updatedAt: new Date().toISOString(),
    workspaces: input.workspaces,
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
