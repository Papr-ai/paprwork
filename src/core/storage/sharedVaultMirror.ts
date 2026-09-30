import type { CustomKeyMetadata } from "./CustomKeysStorage.js";
import type { IntegrationKeyVaultAudience } from "./customKeysVault.js";

export type VaultOrigin = "local" | "shared";

export interface SharedVaultKeyInput {
  name: string;
  value: string;
  description?: string;
  permission?: "always" | "ask";
  clientAccess?: "server" | "client";
  vaultAudience: Extract<
    IntegrationKeyVaultAudience,
    "namespace" | "org" | "members"
  >;
  sharedOwnerUserId?: string;
  sharedSyncedAt?: string;
  source?: "manual" | "oauth";
}

export function sharedMirrorKeyId(name: string): string {
  return `shared-${name.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_")}`;
}

export function shouldPushKeyToCloud(meta: CustomKeyMetadata): boolean {
  return meta.vaultOrigin !== "shared";
}

export function mapCloudVaultPermission(
  permission: string | undefined,
): "always" | "ask" {
  return permission === "ask" ? "ask" : "always";
}

export function sharedNamesToPrune(
  localSharedNames: readonly string[],
  remoteNames: readonly string[],
): string[] {
  const remote = new Set(remoteNames.map((name) => name.trim().toUpperCase()));
  return localSharedNames.filter((name) => !remote.has(name.trim().toUpperCase()));
}
