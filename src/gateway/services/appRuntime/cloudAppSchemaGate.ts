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

export async function evaluateCloudAppSchemaGate(input: {
  turso: TursoDbAdapter;
  runtimeAuth: AppRuntimeRouteAuth;
  orgId: string;
  namespaceId: string;
  userId: string;
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
    runtimeAuth: input.runtimeAuth,
    config: input.config,
  });

  const satisfied =
    remoteSchemaVersion !== null && remoteSchemaVersion >= required;

  if (satisfied) {
    bundleRevisionPins.delete(pinKey(input.namespaceId, input.runtimeAuth.slug));
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
  const pinRevision =
    existingPin ??
    (input.currentRevision ? input.currentRevision : meta!.distRevision);

  if (input.currentRevision && !existingPin) {
    setPinnedBundleRevision(
      input.namespaceId,
      input.runtimeAuth.slug,
      pinRevision,
    );
  }

  return {
    blocked: true,
    requiredSchemaVersion: required,
    remoteSchemaVersion,
    pinnedRevision: pinRevision,
  };
}
