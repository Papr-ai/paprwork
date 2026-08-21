/**
 * Resolve which Parse user id selects a Turso replica segment for cloud mini-apps.
 *
 * Shared registry sources use the publish-catalog owner (publisher).
 * Per-user sources use the signed-in visitor (caller).
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

/** Pick Turso replica user segment for one linked data source. */
export function resolveTursoActingUserIdForSource(
  source: AppDataSource,
  actors: TursoDbActors,
): string {
  const registry = getDatabaseRegistryService();
  const record = registry.getRecordForSource(source);
  return resolveTursoActingUserId(record?.isolation, actors);
}
