/**
 * Cloud App Host — schema readiness vs git bundle (revision pin only; no user banner).
 */

import type { TursoDbAdapter } from "./TursoDbAdapter.js";
import type { AppRuntimeRouteAuth } from "./types.js";
import type { AppDataSourcesFile } from "../appDataSources.js";
import { normalizeRequiredSchemaVersion } from "../jobs/migrationLedgerPolicy.js";
import {
  readCloudAppMetaFromContent,
  type CloudAppMetaFile,
  PAPR_APP_META_RELATIVE_PATH,
} from "../cloudSync/cloudAppMeta.js";
import { fetchCachedRuntimeRepoFile } from "./cloudAppHostCache.js";

const bundleRevisionPins = new Map<string, string>();

/** Last bundle revision known to match Turso schema — used when a new deploy outruns migrations. */
const lastSatisfiedBundleRevision = new Map<string, string>();

function pinKey(namespaceId: string, slug: string): string {
  return `${namespaceId}/${slug}`;
}

export function getPinnedBundleRevision(
  namespaceId: string,
  slug: string,
): string | null {
  return bundleRevisionPins.get(pinKey(namespaceId, slug)) ?? null;
}

export function setPinnedBundleRevision(
  namespaceId: string,
  slug: string,
  revision: string,
): void {
  bundleRevisionPins.set(pinKey(namespaceId, slug), revision);
}

export interface SchemaGateResult {
  blocked: boolean;
  requiredSchemaVersion: string | null;
  remoteSchemaVersion: string | null;
  pinnedRevision: string | null;
}

export interface AppRevisionSchemaPayload {
  revision: string;
  requiredSchemaVersion: string | null;
  remoteSchemaVersion: string | null;
  schemaReady: boolean;
  schemaSyncing: boolean;
}

const SCHEMA_STATUS_TTL_MS = 15_000;
const schemaStatusCache = new Map<
  string,
  { value: SchemaGateResult; freshUntil: number }
>();

function schemaStatusCacheKey(input: {
  namespaceId: string;
  slug: string;
  userId: string;
  callerUserId?: string;
}): string {
  return `${input.namespaceId}:${input.slug}:${input.userId}:${input.callerUserId ?? ""}`;
}

export function resetSchemaStatusCacheForTests(): void {
  schemaStatusCache.clear();
  bundleRevisionPins.clear();
  lastSatisfiedBundleRevision.clear();
}

export function getLastSatisfiedBundleRevision(
  namespaceId: string,
  slug: string,
): string | null {
  return lastSatisfiedBundleRevision.get(pinKey(namespaceId, slug)) ?? null;
}

export function toAppRevisionSchemaPayload(
  revision: string,
  gate: SchemaGateResult,
): AppRevisionSchemaPayload {
  const required = gate.requiredSchemaVersion;
  const serveRevision =
    gate.blocked && gate.pinnedRevision ? gate.pinnedRevision : revision;
  // Never surface schema_syncing UX — serve pre-update bundle or let migrate catch up quietly.
  return {
    revision: serveRevision,
    requiredSchemaVersion: required,
    remoteSchemaVersion: gate.remoteSchemaVersion,
    schemaReady: true,
    schemaSyncing: false,
  };
}

export async function evaluateCloudAppSchemaGate(input: {
  turso: TursoDbAdapter;
  runtimeAuth: AppRuntimeRouteAuth;
  orgId: string;
  namespaceId: string;
  userId: string;
  callerUserId?: string;
  config: AppDataSourcesFile;
  currentRevision: string | null;
}): Promise<SchemaGateResult> {
  const metaFile = await fetchCachedRuntimeRepoFile(
    input.runtimeAuth,
    PAPR_APP_META_RELATIVE_PATH,
  );
  const meta: CloudAppMetaFile | null = metaFile
    ? readCloudAppMetaFromContent(metaFile.content)
    : null;

  const required = normalizeRequiredSchemaVersion(meta?.requiredSchemaVersion);
  if (!required) {
    return {
      blocked: false,
      requiredSchemaVersion: null,
      remoteSchemaVersion: null,
      pinnedRevision: null,
    };
  }

  const remoteSchemaVersion = await input.turso.getMaxAppliedMigrationId({
    orgId: input.orgId,
    namespaceId: input.namespaceId,
    userId: input.userId,
    callerUserId: input.callerUserId,
    runtimeAuth: input.runtimeAuth,
    config: input.config,
  });

  const satisfied =
    remoteSchemaVersion !== null && remoteSchemaVersion >= required;

  const key = pinKey(input.namespaceId, input.runtimeAuth.slug);

  if (satisfied) {
    bundleRevisionPins.delete(key);
    if (input.currentRevision) {
      lastSatisfiedBundleRevision.set(key, input.currentRevision);
    }
    return {
      blocked: false,
      requiredSchemaVersion: required,
      remoteSchemaVersion,
      pinnedRevision: null,
    };
  }

  const existingPin = getPinnedBundleRevision(
    input.namespaceId,
    input.runtimeAuth.slug,
  );
  const lastGood = lastSatisfiedBundleRevision.get(key);
  const pinRevision = existingPin ?? lastGood ?? null;

  if (pinRevision && !existingPin) {
    setPinnedBundleRevision(input.namespaceId, input.runtimeAuth.slug, pinRevision);
  }

  return {
    blocked: true,
    requiredSchemaVersion: required,
    remoteSchemaVersion,
    pinnedRevision: pinRevision,
  };
}

/** Cached schema gate for API/revision endpoints — not on HTML critical path. */
export async function evaluateCloudAppSchemaGateCached(input: {
  turso: TursoDbAdapter;
  runtimeAuth: AppRuntimeRouteAuth;
  orgId: string;
  namespaceId: string;
  userId: string;
  callerUserId?: string;
  config: AppDataSourcesFile;
  currentRevision: string | null;
  bypassCache?: boolean;
}): Promise<SchemaGateResult> {
  const key = schemaStatusCacheKey({
    namespaceId: input.namespaceId,
    slug: input.runtimeAuth.slug,
    userId: input.userId,
    callerUserId: input.callerUserId,
  });
  if (!input.bypassCache) {
    const cached = schemaStatusCache.get(key);
    if (cached && Date.now() < cached.freshUntil) {
      return cached.value;
    }
  }

  const result = await evaluateCloudAppSchemaGate(input);
  schemaStatusCache.set(key, {
    value: result,
    freshUntil: Date.now() + SCHEMA_STATUS_TTL_MS,
  });
  return result;
}

/** Fire-and-forget warm — populates schema status cache without blocking HTML. */
export function warmCloudAppSchemaGate(input: {
  turso: TursoDbAdapter;
  runtimeAuth: AppRuntimeRouteAuth;
  orgId: string;
  namespaceId: string;
  userId: string;
  callerUserId?: string;
  config: AppDataSourcesFile;
  currentRevision: string | null;
}): void {
  void evaluateCloudAppSchemaGateCached(input).catch(() => {});
}
