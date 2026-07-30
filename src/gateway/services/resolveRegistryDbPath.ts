/**
 * Resolve standalone registry database paths after flat → namespace migration.
 */

import { existsSync, statSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { getPaprDataDir } from "../../core/utils/paprRoot.js";

export function extractDatabaseSlugFromPath(dbPath: string): string | null {
  const match = dbPath.match(/[/\\]databases[/\\]([^/\\]+)[/\\]data\.db$/i);
  return match?.[1] ?? null;
}

/** Flat layout: ~/Papr/data/databases/{slug}/data.db */
export function isFlatRegistryDbPath(dbPath: string, paprBase: string): boolean {
  const normalized = path.normalize(dbPath);
  const flatPrefix = path.join(paprBase, "data", "databases") + path.sep;
  return normalized.startsWith(flatPrefix);
}

export function workspaceRegistryDbPath(
  slug: string,
  dataDir?: string,
): string {
  return path.join(dataDir ?? getPaprDataDir(), "databases", slug, "data.db");
}

export function isReadableDbFile(dbPath: string): boolean {
  try {
    return existsSync(dbPath) && statSync(dbPath).size > 0;
  } catch {
    return false;
  }
}

export function resolveReadableRegistryDbPath(input: {
  dbPath?: string;
  registryPath?: string;
  dataDir?: string;
}): string | null {
  const candidates = [input.dbPath?.trim(), input.registryPath?.trim()].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    if (isReadableDbFile(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    const slug = extractDatabaseSlugFromPath(candidate);
    if (!slug) {
      continue;
    }
    const workspacePath = workspaceRegistryDbPath(slug, input.dataDir);
    if (isReadableDbFile(workspacePath)) {
      return workspacePath;
    }
  }

  return null;
}

export async function findRegistryDbInOrgNamespaces(input: {
  paprBase: string;
  activePaprHome: string;
  slug: string;
}): Promise<string | null> {
  const orgMatch = input.activePaprHome.match(
    /[/\\]orgs[/\\]([^/\\]+)[/\\]namespaces[/\\]([^/\\]+)/,
  );
  if (!orgMatch) {
    return null;
  }

  const orgId = orgMatch[1]!;
  const namespacesDir = path.join(input.paprBase, "orgs", orgId, "namespaces");
  let namespaceIds: string[];
  try {
    namespaceIds = await fs.readdir(namespacesDir);
  } catch {
    return null;
  }

  for (const namespaceId of namespaceIds) {
    const candidate = path.join(
      namespacesDir,
      namespaceId,
      "data",
      "databases",
      input.slug,
      "data.db",
    );
    if (isReadableDbFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function ensureRegistryDbInWorkspace(input: {
  sourcePath: string;
  targetPath: string;
}): Promise<boolean> {
  if (!isReadableDbFile(input.sourcePath)) {
    return false;
  }
  if (isReadableDbFile(input.targetPath)) {
    return true;
  }

  await fs.mkdir(path.dirname(input.targetPath), { recursive: true });
  await fs.copyFile(input.sourcePath, input.targetPath);
  return isReadableDbFile(input.targetPath);
}
