/**
 * Cloud git repo + vault scope helpers for memory server APIs.
 */

import type { IntegrationKeyOrgScope, IntegrationKeyVaultAudience } from "../storage/customKeysVault.js";
import { normalizeIntegrationKeyVaultAudience } from "../storage/customKeysVault.js";
import { readActiveWorkspacePointer } from "./paprWorkspace.js";

export type CloudRepoScope = "user" | "namespace" | "org";

export interface CloudReposRequestBody {
  scope: CloudRepoScope;
  namespace_id?: string;
  template?: "default";
}

/** Per-key vault entry for POST /v1/cloud/vault/sync (memory server). */
export interface CloudVaultKeyEntry {
  name: string;
  value: string;
  source?: string;
  clientAccess?: "server" | "client";
  /** Per-key sharing scope — overrides batch VaultSyncRequest.scope when set. */
  shareScope?: CloudRepoScope;
  /** When desktop selects a specific organization for storage. */
  targetOrgId?: string;
  /** always_allow | ask — stored as label for future job gating. */
  permission?: string;
}

export function buildCloudReposRequestBody(
  scope: CloudRepoScope = "user",
): CloudReposRequestBody {
  const pointer = readActiveWorkspacePointer();
  const namespaceId =
    process.env.PAPR_NAMESPACE_ID?.trim() || pointer?.namespaceId;
  return {
    scope,
    ...(namespaceId ? { namespace_id: namespaceId } : {}),
    ...(scope === "user" ? { template: "default" as const } : {}),
  };
}

export function resolveActiveNamespaceId(): string | undefined {
  const pointer = readActiveWorkspacePointer();
  return process.env.PAPR_NAMESPACE_ID?.trim() || pointer?.namespaceId;
}

export function mapCustomKeyMetadataToVaultEntry(input: {
  meta: {
    name: string;
    permission?: "always" | "ask";
    clientAccess?: "server" | "client";
    vaultAudience?: IntegrationKeyVaultAudience;
    orgScope?: IntegrationKeyOrgScope | "global";
    organizationId?: string;
    source?: "manual" | "oauth";
    managedBy?: "oauth";
    oauthProvider?: "openai" | "anthropic";
    description?: string;
  };
  value: string;
  source: string;
}): CloudVaultKeyEntry {
  const shareScope = normalizeIntegrationKeyVaultAudience(
    input.meta.vaultAudience,
  );
  const permission =
    input.meta.permission === "ask" ? "ask" : "always_allow";

  const entry: CloudVaultKeyEntry = {
    name: input.meta.name,
    value: input.value,
    source: input.source,
    clientAccess: input.meta.clientAccess ?? "server",
    shareScope,
    permission,
  };

  if (
    input.meta.orgScope === "organization" &&
    input.meta.organizationId?.trim()
  ) {
    entry.targetOrgId = input.meta.organizationId.trim();
  }

  return entry;
}

export function buildCloudVaultRequestBody(
  keys: CloudVaultKeyEntry[],
  scope: CloudRepoScope = "user",
): { scope: CloudRepoScope; namespace_id?: string; keys: CloudVaultKeyEntry[] } {
  const namespaceId = resolveActiveNamespaceId();
  return {
    scope,
    ...(namespaceId ? { namespace_id: namespaceId } : {}),
    keys,
  };
}
