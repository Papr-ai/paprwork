/**
 * Disk cache for Papr workspaces + namespaces (instant Settings load).
 *
 * The rules below are the ones a previous version of this cache broke, each of
 * which stranded a user in a single workspace with no way out but deleting the
 * file by hand:
 *
 *   1. Store what the server returned, verbatim. Dedupe and display naming are
 *      applied on read, so a bug in either is a display bug we fix with a
 *      deploy rather than permanent data loss on disk.
 *   2. Scope to a user. The path is global, so an unlabelled cache serves the
 *      previous account's workspaces after a logout and login.
 *   3. Stamp each section with its fetch time and expose the age, so callers
 *      can refresh stale data instead of treating any non-empty list as
 *      authoritative forever.
 *   4. Never let an upstream failure shrink the cache to nothing.
 *   5. Write atomically. A half-written file parses as corrupt, and a corrupt
 *      file reads as "no cache", silently discarding everything.
 *
 * Writes are synchronous and only the main process touches this file, so a
 * read-modify-write cannot interleave and no lock is needed. The atomic rename
 * is for crashes mid-write, not for concurrency.
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
  /**
   * Members per the server. Undefined when the row predates this field, which
   * ranks below any known count when collapsing duplicates.
   */
  memberCount?: number;
  /** This row is the workspace its own organization points at. */
  isOrgPrimary?: boolean;
}

interface CachedNamespaceEntry {
  fetchedAt: string;
  namespaces: CachedNamespace[];
}

export interface PaprWorkspaceCacheFile {
  version: 4;
  /** Owner of this cache. A mismatch is a miss, never a fallback. */
  userId: string;
  workspacesFetchedAt: string;
  /** Rows exactly as fetched. Deduped on read, never on write. */
  workspaces: CachedWorkspace[];
  namespacesByOrgId: Record<string, CachedNamespaceEntry>;
}

/**
 * Bumped to 4 when rows gained `memberCount` and `isOrgPrimary`. A v3 row has
 * neither, so every duplicate in a scope would rank equal and the collapse would
 * fall back to arrival order — the bug this data exists to fix. Discarding those
 * files costs one refetch and makes the fix apply on first launch.
 */
export const WORKSPACE_CACHE_VERSION = 4;

/** Below this age, serve without triggering a refresh. */
export const CACHE_FRESH_MS = 5 * 60_000;

/** Above this age, treat as a miss — too old to show even briefly. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const CACHE_FILENAME = "papr-workspace-cache.json";

function getCachePath(): string {
  // Global cache — not per-namespace (getPaprDataDir moves when workspace switches).
  return path.join(getPaprBaseDir(), "data", CACHE_FILENAME);
}

function ageOf(fetchedAt: string | undefined): number {
  const timestamp = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  return Number.isFinite(timestamp)
    ? Math.max(0, Date.now() - timestamp)
    : Number.POSITIVE_INFINITY;
}

/**
 * The stored file for this user, or null when there is nothing usable: no file,
 * corrupt JSON, an older schema, or a cache belonging to a different account.
 */
function readForUser(userId: string): PaprWorkspaceCacheFile | null {
  if (!userId) return null;

  let parsed: PaprWorkspaceCacheFile;
  try {
    parsed = JSON.parse(
      fs.readFileSync(getCachePath(), "utf8"),
    ) as PaprWorkspaceCacheFile;
  } catch {
    return null;
  }

  // Pre-v3 files carry no userId, so they cannot be attributed to an account,
  // and v3 rows lack the fields that pick between duplicate workspaces.
  // Discarding either costs one refetch.
  if (parsed?.version !== WORKSPACE_CACHE_VERSION) return null;
  if (!Array.isArray(parsed.workspaces)) return null;
  if (!parsed.userId || parsed.userId !== userId) return null;

  return {
    ...parsed,
    namespacesByOrgId: parsed.namespacesByOrgId ?? {},
  };
}

function persist(next: PaprWorkspaceCacheFile): void {
  const target = getCachePath();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort — a stray temp file is harmless.
    }
    // A cache write failing must not break login or workspace switching.
    console.warn("[PaprWorkspaceCache] Failed to write cache:", error);
  }
}

/**
 * Drop namespace entries past the usable age.
 *
 * Pruning by workspace membership would be wrong: a workspace can host several
 * organizations, and the switcher caches namespaces for orgs that never appear
 * as any workspace's primary org. Age is the only bound that cannot delete a
 * still-reachable org.
 */
function pruneNamespaces(
  entries: Record<string, CachedNamespaceEntry>,
): Record<string, CachedNamespaceEntry> {
  const kept: Record<string, CachedNamespaceEntry> = {};
  for (const [orgId, entry] of Object.entries(entries)) {
    if (!entry?.namespaces?.length) continue;
    if (ageOf(entry.fetchedAt) > CACHE_MAX_AGE_MS) continue;
    kept[orgId] = entry;
  }
  return kept;
}

/**
 * The workspace name with Parse display artifacts removed, or null when nothing
 * meaningful is left. A placeholder name cannot tell two rows apart.
 */
function meaningfulWorkspaceName(workspace: CachedWorkspace): string | null {
  const raw = (workspace.workspaceName ?? workspace.name ?? "").trim();
  // Parse renders the viewer's own workspace as "<orgName> (you)", and orgName is
  // itself often literally "null" for personal workspaces.
  const name = raw.replace(/\s*\(you\)\s*$/i, "").trim().toLowerCase();
  if (!name || name === "null" || name === "undefined" || name === "workspace") {
    return null;
  }
  return name;
}

/** Prefer a real name over "Workspace"/"null"/empty when collapsing rows. */
function workspaceNameScore(workspace: CachedWorkspace): number {
  const name = workspace.name?.trim().toLowerCase();
  if (!name || name === "null" || name === "undefined") return 0;
  if (name === "workspace") return 1;
  return 2;
}

/**
 * How strong a claim a row has to be *the* workspace for its scope, best first.
 *
 * Duplicate provisioning leaves several workspaces sharing a name, org and
 * namespace, and only one of them is the one the team actually uses. Keeping
 * whichever arrived first picked a one-member shell over a 601-member workspace,
 * so the switcher showed the right name attached to the wrong id and the team
 * list came back with only the viewer in it.
 *
 * Ordered by how hard each signal is to corrupt:
 *   1. The organization's own `workspace` pointer — the org naming its
 *      authoritative workspace. Not derived from the viewer's session.
 *   2. `memberCount` — computed server-side from real membership, and a plain
 *      field, so it survives the ACL filtering that hides `organization`.
 *   3. Name quality, to keep the existing preference for a real label.
 *
 * `isSelected` is deliberately absent. The buggy client wrote that flag onto
 * whichever duplicate it had already picked, so it can confirm the wrong row.
 */
function workspaceAuthorityRank(workspace: CachedWorkspace): number[] {
  return [
    workspace.isOrgPrimary === true ? 1 : 0,
    // Below any known count, so a readable 1 outranks an unreadable unknown.
    typeof workspace.memberCount === "number" ? workspace.memberCount : -1,
    workspaceNameScore(workspace),
  ];
}

/** True when `candidate` is a strictly better representative than `existing`. */
function isStrongerWorkspace(
  candidate: CachedWorkspace,
  existing: CachedWorkspace,
): boolean {
  const left = workspaceAuthorityRank(candidate);
  const right = workspaceAuthorityRank(existing);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  // Fully tied — keep the row already held so output stays first-seen stable.
  return false;
}

/** Org + namespace a row resolves to. Rows without a namespace stand alone. */
function workspaceScopeKey(workspace: CachedWorkspace): string {
  return workspace.defaultNamespaceId
    ? `${workspace.organizationId ?? ""}::${workspace.defaultNamespaceId}`
    : `id::${workspace.id}`;
}

/**
 * Collapse workspaces that resolve to the same org + namespace.
 *
 * Duplicate provisioning (and older builds that created a workspace on every
 * login) can leave several workspace rows pointing at one namespace. Those are
 * indistinguishable to the user and make the switcher look broken.
 *
 * Org + namespace alone is not enough to call two rows duplicates, though.
 * `resolveNamespaceOrganizationId` maps every workspace where the user owns a
 * non-matching org onto their single developer org, so genuinely different
 * workspaces reach this function sharing an organizationId *and* a
 * defaultNamespaceId. Keying on just those erased all but one, which is how a
 * user ends up pinned to one workspace with nothing to switch to.
 *
 * So within a scope: rows with distinct real names are kept, and placeholder-named
 * rows are absorbed into the named ones (or collapsed among themselves if no row
 * in the scope has a real name). Where several rows do share a name, the survivor
 * is chosen by `workspaceAuthorityRank` rather than arrival order.
 *
 * This runs on read only. The stored rows stay untouched, so a mistake here
 * hides a workspace until the next deploy instead of destroying it on disk.
 */
export function dedupeCachedWorkspaces(
  workspaces: CachedWorkspace[],
): CachedWorkspace[] {
  /** scope → (name → best row), preserving first-seen order at both levels. */
  const scopes = new Map<string, Map<string, CachedWorkspace>>();
  const placeholders = new Map<string, CachedWorkspace>();

  for (const workspace of workspaces) {
    const scope = workspaceScopeKey(workspace);
    const name = meaningfulWorkspaceName(workspace);

    if (!name) {
      const existing = placeholders.get(scope);
      if (!existing || isStrongerWorkspace(workspace, existing)) {
        placeholders.set(scope, workspace);
      }
      continue;
    }

    let named = scopes.get(scope);
    if (!named) {
      named = new Map<string, CachedWorkspace>();
      scopes.set(scope, named);
    }

    const existing = named.get(name);
    if (!existing || isStrongerWorkspace(workspace, existing)) {
      named.set(name, workspace);
    }
  }

  const result: CachedWorkspace[] = [];
  const emitted = new Set<string>();

  // Walk the original order so the output is stable for callers and the UI.
  for (const workspace of workspaces) {
    const scope = workspaceScopeKey(workspace);
    const named = scopes.get(scope);

    if (!named) {
      // Scope has no real name anywhere — emit the single best placeholder.
      const placeholder = placeholders.get(scope);
      if (placeholder && !emitted.has(scope)) {
        emitted.add(scope);
        result.push(placeholder);
      }
      continue;
    }

    const name = meaningfulWorkspaceName(workspace);
    // Placeholder rows in a scope that has named rows are duplicates of them.
    if (!name) continue;

    const key = `${scope}::${name}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const best = named.get(name);
    if (best) result.push(best);
  }

  return result;
}

export interface CachedRead<T> {
  data: T;
  ageMs: number;
  /** Usable now, but a refresh should be kicked off. */
  isStale: boolean;
}

/**
 * Cached workspaces for this user, deduped for display, or null when there is
 * nothing usable to show.
 */
export function readCachedWorkspaces(
  userId: string,
): CachedRead<CachedWorkspace[]> | null {
  const file = readForUser(userId);
  if (!file || file.workspaces.length === 0) return null;

  const ageMs = ageOf(file.workspacesFetchedAt);
  if (ageMs > CACHE_MAX_AGE_MS) return null;

  return {
    data: dedupeCachedWorkspaces(file.workspaces),
    ageMs,
    isStale: ageMs > CACHE_FRESH_MS,
  };
}

export function writeCachedWorkspaces(
  userId: string,
  workspaces: CachedWorkspace[],
): void {
  if (!userId) return;
  const existing = readForUser(userId);
  const existingCount = existing?.workspaces.length ?? 0;

  // Losing every workspace is nearly always a partial upstream failure rather
  // than the user leaving all of them, and persisting it empties the switcher
  // with no way back. A smaller-but-non-empty list can be a real membership
  // change, so that one is logged and accepted rather than pinning the user to
  // rows they no longer belong to.
  if (workspaces.length === 0 && existingCount > 0) {
    console.warn(
      `[PaprWorkspaceCache] Refusing to replace ${existingCount} cached ` +
        `workspaces with an empty list`,
    );
    return;
  }
  if (existingCount > 0 && workspaces.length < existingCount) {
    console.log(
      `[PaprWorkspaceCache] Workspace count fell from ${existingCount} to ` +
        `${workspaces.length}; accepting as a membership change`,
    );
  }

  persist({
    version: WORKSPACE_CACHE_VERSION,
    userId,
    workspacesFetchedAt: new Date().toISOString(),
    workspaces,
    namespacesByOrgId: pruneNamespaces(existing?.namespacesByOrgId ?? {}),
  });
}

export function readCachedNamespaces(
  userId: string,
  orgId: string,
): CachedRead<CachedNamespace[]> | null {
  const entry = readForUser(userId)?.namespacesByOrgId?.[orgId];
  if (!entry?.namespaces?.length) return null;

  const ageMs = ageOf(entry.fetchedAt);
  if (ageMs > CACHE_MAX_AGE_MS) return null;

  return {
    data: entry.namespaces.map((namespace) => ({ ...namespace })),
    ageMs,
    isStale: ageMs > CACHE_FRESH_MS,
  };
}

export function writeCachedNamespaces(
  userId: string,
  orgId: string,
  namespaces: CachedNamespace[],
): void {
  if (!userId || !orgId) return;
  const existing = readForUser(userId);

  // Same reasoning as workspaces: an empty namespace list on top of a populated
  // one is a failed fetch, not a deletion.
  const existingCount = existing?.namespacesByOrgId?.[orgId]?.namespaces.length ?? 0;
  if (namespaces.length === 0 && existingCount > 0) {
    console.warn(
      `[PaprWorkspaceCache] Refusing to replace ${existingCount} cached ` +
        `namespaces for org ${orgId} with an empty list`,
    );
    return;
  }

  persist({
    version: WORKSPACE_CACHE_VERSION,
    userId,
    workspacesFetchedAt: existing?.workspacesFetchedAt ?? new Date(0).toISOString(),
    workspaces: existing?.workspaces ?? [],
    namespacesByOrgId: {
      ...pruneNamespaces(existing?.namespacesByOrgId ?? {}),
      [orgId]: { fetchedAt: new Date().toISOString(), namespaces },
    },
  });
}

/** Drop the cache entirely — used on logout so the next account starts clean. */
export function clearPaprWorkspaceCache(): void {
  const target = getCachePath();
  try {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { force: true });
    console.log("[PaprWorkspaceCache] Cleared");
  } catch (error) {
    console.warn("[PaprWorkspaceCache] Failed to clear cache:", error);
  }
}
