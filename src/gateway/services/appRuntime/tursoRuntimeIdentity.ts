/**
 * Resolve Turso identity for cloud mini-apps and desktop replicas.
 *
 * - **Acting user** (tokens, cache keys): authenticated caller for per-user sources;
 *   publisher for shared sources.
 * - **Suffix user** (short name `d-{id8}-u-{uid8}`): only non-publishers on per-user
 *   sources. The publisher keeps the shared primary (`d-{id8}`) — Option A.
 */

import type { AppDataSource } from "../appDataSources.js";
import {
  getDatabaseRegistryService,
  type DatabaseRecord,
} from "../DatabaseRegistryService.js";

export interface TursoDbActors {
  /** Publish-catalog owner — Turso `{user8}` segment for shared sources. */
  publisherUserId: string;
  /** Session visitor (`externalUserId`) — segment for per-user sources. */
  callerUserId?: string;
}

function normalizeUserIdForCompare(userId: string): string {
  return userId.replace(/-/g, "").trim().toLowerCase();
}

export function isSamePaprUser(a: string, b: string): boolean {
  return normalizeUserIdForCompare(a) === normalizeUserIdForCompare(b);
}

/** Authenticated user id for Turso token requests and client cache keys. */
export function resolveTursoActingUserId(
  isolation: DatabaseRecord["isolation"] | undefined,
  actors: TursoDbActors,
): string {
  if (isolation === "per-user") {
    const caller = actors.callerUserId?.trim();
    if (!caller) {
      throw new Error(
        "Sign in required to access per-user database sources",
      );
    }
    return caller;
  }
  return actors.publisherUserId;
}

/**
 * User id passed to `tursoNameForRecord` for `-u-{uid8}` suffix.
 * Returns `undefined` when the short name should stay on the shared primary.
 */
export function resolveTursoSuffixUserId(
  isolation: DatabaseRecord["isolation"] | undefined,
  actors: TursoDbActors,
): string | undefined {
  if (isolation !== "per-user") {
    return undefined;
  }
  const caller = actors.callerUserId?.trim();
  if (!caller) {
    throw new Error(
      "Sign in required to access per-user database sources",
    );
  }
  const publisher = actors.publisherUserId?.trim();
  if (publisher && isSamePaprUser(caller, publisher)) {
    return undefined;
  }
  return caller;
}

/** Pick Turso replica user segment for one linked data source. */
export function resolveTursoActingUserIdForSource(
  source: AppDataSource,
  actors: TursoDbActors,
): string {
  const registry = getDatabaseRegistryService();
  const record = registry.getRecordForSource(source);
  return resolveTursoActingUserId(record?.isolation, actors);
}

/** Pick `-u-{uid8}` suffix user for one linked data source (Option A). */
export function resolveTursoSuffixUserIdForSource(
  source: AppDataSource,
  actors: TursoDbActors,
): string | undefined {
  const registry = getDatabaseRegistryService();
  const record = registry.getRecordForSource(source);
  return resolveTursoSuffixUserId(record?.isolation, actors);
}
