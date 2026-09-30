/**
 * Turso credential fetch for cloud install — fork vs team collaborate (shared primary).
 */

import type { CloudAppLineageSource } from "../../core/types/cloudAppLineage.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import { mergeCloudActingUserBody } from "../utils/cloudActingUser.js";
import { getPaprApiKey } from "../utils/keyResolver.js";
import type { InstallDbPolicy } from "./cloudInstallDbPolicy.js";
import {
  getDatabaseRegistryService,
  tursoNameForRecord,
} from "./DatabaseRegistryService.js";
import {
  lookupSharedPrimaryTursoEntry,
  registerSharedPrimaryTursoEntries,
  type SharedPrimaryTursoEntry,
} from "./sharedPrimaryTursoStore.js";
import type { TursoCredentials } from "./tursoSyncBridgeCore.js";

export interface InstallTursoCredentialResult {
  creds: TursoCredentials;
  expiresAt?: string;
}

export async function fetchInstallDbTursoCredentials(input: {
  namespaceId: string;
  slug: string;
  tursoShortName: string;
  shareToken?: string;
}): Promise<InstallTursoCredentialResult> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    throw new Error("PAPR_API_KEY not configured");
  }

  const response = await cloudApiFetch("/v1/cloud/apps/install/db-token", {
    method: "POST",
    body: mergeCloudActingUserBody({
      namespaceId: input.namespaceId,
      slug: input.slug,
      database: input.tursoShortName,
      ...(input.shareToken ? { shareToken: input.shareToken } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Install db-token failed (${response.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    tursoUrl?: string;
    authToken?: string;
    expiresAt?: string;
  };
  if (!data.tursoUrl || !data.authToken) {
    throw new Error("Install db-token response missing tursoUrl or authToken");
  }

  return {
    creds: { tursoUrl: data.tursoUrl, authToken: data.authToken },
    expiresAt: data.expiresAt,
  };
}

/** Resolve credentials for a Turso short name (shared-primary registry or installer token). */
export async function fetchTursoCredentialsForInstall(input: {
  installDbPolicy: InstallDbPolicy;
  tursoShortName: string;
  sharedPrimary?: {
    namespaceId: string;
    slug: string;
    shareToken?: string;
  };
}): Promise<InstallTursoCredentialResult> {
  if (input.installDbPolicy === "shared_primary" && input.sharedPrimary) {
    return fetchInstallDbTursoCredentials({
      namespaceId: input.sharedPrimary.namespaceId,
      slug: input.sharedPrimary.slug,
      tursoShortName: input.tursoShortName,
      shareToken: input.sharedPrimary.shareToken,
    });
  }

  const shared = lookupSharedPrimaryTursoEntry(input.tursoShortName);
  if (shared) {
    return fetchInstallDbTursoCredentials({
      namespaceId: shared.namespaceId,
      slug: shared.slug,
      tursoShortName: input.tursoShortName,
      shareToken: shared.shareToken,
    });
  }

  throw new Error(
    `No shared-primary Turso mapping for ${input.tursoShortName}`,
  );
}

export function registerSharedPrimaryTursoForInstalledApp(input: {
  localAppId: string;
  source: CloudAppLineageSource;
  registryDbIds: readonly string[];
  shareToken?: string;
}): void {
  if (input.registryDbIds.length === 0) {
    return;
  }

  const registry = getDatabaseRegistryService();
  const entries: Array<
    SharedPrimaryTursoEntry & { tursoShortName: string }
  > = [];

  for (const dbId of input.registryDbIds) {
    const record = registry.getById(dbId);
    if (!record || record.isolation === "per-user") {
      continue;
    }
    const tursoShortName = tursoNameForRecord(record, input.source.userId);
    entries.push({
      tursoShortName,
      namespaceId: input.source.namespaceId,
      slug: input.source.slug,
      publisherUserId: input.source.userId,
      localAppId: input.localAppId,
      ...(input.shareToken ? { shareToken: input.shareToken } : {}),
    });
  }

  registerSharedPrimaryTursoEntries(entries);
}
