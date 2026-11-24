/**
 * Turso token housekeeping tied to an installed app.
 *
 * The token cache is keyed by org/namespace/user/database name only, so the
 * same short name (d-83320841) resolves to whichever physical database the
 * memory server answered with first: the publisher's shared copy, or an empty
 * copy in the caller's own segment. A wrong answer then sticks for the token's
 * lifetime (two weeks for own-segment tokens) and survives uninstall/reinstall.
 *
 * - `tokenScopeAppIdFor` sends the app id the server can match (the publisher's
 *   app id for a copy on team data, not the local copy's id).
 * - `cachedTokenMatchesInstall` rejects a cached token that points at a
 *   different segment than the installed copy expects.
 * - `forgetTursoCredentialsForApp` drops tokens + clients when an app is
 *   installed or deleted, so no stale token outlives the app.
 */

import { readFileSync } from "fs";
import path from "path";
import { parseCloudAppLineageFile } from "../../core/utils/cloudAppLineage.js";
import { usesSharedData } from "../../core/utils/copyAxes.js";
import { getPaprAppsRoot } from "../../core/utils/paprRoot.js";
import { parseDataSourcesFile } from "./appDataSources.js";
import { CLOUD_LINEAGE_FILENAME } from "./CloudAppLineageService.js";
import { resolveTursoDatabaseNameForSource } from "./DatabaseRegistryService.js";
import { resolveSharedPrimaryTursoEntry } from "./sharedPrimaryTursoResolve.js";

/**
 * A team copy could not get a token for the team's database (the server
 * refused, or answered with a different copy). Callers must not fall back to
 * an own copy: show "Can't reach the team's data" and retry later.
 */
export class SharedDatabaseUnreachableError extends Error {
  readonly code = "shared_database_unreachable";
  constructor(readonly databaseName: string) {
    super(
      `Can't reach the team's data for ${databaseName}: the cloud returned a different database than this team copy uses. Will retry.`,
    );
    this.name = "SharedDatabaseUnreachableError";
  }
}

/** Same as memory `turso_service._sanitize_name(part, 8)`. */
export function tursoSegmentPart(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 8);
}

/** `libsql://p-{org8}-{ns8}-{user8}-` for one owner's segment. */
export function tursoSegmentUrlPrefix(owner: {
  orgId: string;
  namespaceId: string;
  userId: string;
}): string {
  return `libsql://p-${tursoSegmentPart(owner.orgId)}-${tursoSegmentPart(owner.namespaceId)}-${tursoSegmentPart(owner.userId)}-`;
}

function readLineage(appId: string) {
  try {
    const raw = readFileSync(
      path.join(getPaprAppsRoot(), appId, CLOUD_LINEAGE_FILENAME),
      "utf8",
    );
    return parseCloudAppLineageFile(raw);
  } catch {
    return null;
  }
}

/**
 * App id to send with a token request. A copy on team data is known to the
 * server by the publisher's app id; its own local id matches nothing there.
 */
export function tokenScopeAppIdFor(localAppId: string | undefined): string | undefined {
  const trimmed = localAppId?.trim();
  if (!trimmed) return undefined;
  const lineage = readLineage(trimmed);
  if (lineage && usesSharedData(lineage) && lineage.source.appId?.trim()) {
    return lineage.source.appId.trim();
  }
  return trimmed;
}

/**
 * False when a team copy on this desktop uses `databaseName` but the cached
 * token points somewhere other than the publisher's segment. Unknown → true
 * (never throw away a token we cannot judge).
 */
export function cachedTokenMatchesInstall(
  databaseName: string,
  tursoUrl: string,
): boolean {
  let entry: ReturnType<typeof resolveSharedPrimaryTursoEntry> = null;
  try {
    entry = resolveSharedPrimaryTursoEntry(databaseName);
  } catch {
    return true;
  }
  if (!entry) return true;
  const lineage = readLineage(entry.localAppId);
  // Only judge copies the install explicitly put on team data. Older linked
  // installs have no databasePolicy; some of them (public/link access) are
  // legitimately on their own data, so an own-segment token is correct there.
  if (lineage?.databasePolicy !== "shared") return true;
  if (!lineage.source.orgId || !lineage.source.namespaceId || !lineage.source.userId) {
    return true;
  }
  return tursoUrl.startsWith(tursoSegmentUrlPrefix(lineage.source));
}

/** Turso short names an app links (registry DBs + job DBs). */
export function tursoNamesForApp(appId: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(
      path.join(getPaprAppsRoot(), appId, "data-sources.json"),
      "utf8",
    );
  } catch {
    return [];
  }
  const names = new Set<string>();
  try {
    for (const source of parseDataSourcesFile(raw).sources) {
      const name = resolveTursoDatabaseNameForSource(source);
      if (name) names.add(name);
    }
  } catch {
    return [];
  }
  return [...names];
}

/**
 * Drop cached tokens + open cloud clients for every database an app links.
 * Call on install (the copy may now point at a different physical database)
 * and on delete (no token should outlive the app). Cheap: the next use just
 * asks the server again.
 */
export async function forgetTursoCredentialsForApp(
  appId: string,
  reason: string,
  names: readonly string[] = tursoNamesForApp(appId),
): Promise<string[]> {
  if (names.length === 0) return [];
  const { getTursoSyncBridge } = await import("./TursoSyncBridge.js");
  const { forgetDbRouterTursoClient } = await import("./appRuntime/DbRouter.js");
  const bridge = getTursoSyncBridge();
  for (const name of names) {
    bridge?.invalidateCredentialsCache(name);
    forgetDbRouterTursoClient(name);
  }
  console.log(
    `[TursoCredentials] Dropped ${names.length} cached token(s) for app ${appId} (${reason}): ${names.join(", ")}`,
  );
  return [...names];
}
