import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { KeyClientAccess } from "../../core/types/customKeys.js";
import { normalizeKeyClientAccess } from "../../core/types/customKeys.js";
import type { CustomKeyMetadata } from "../../core/storage/CustomKeysStorage.js";
import { isGlobalCustomKeyName } from "../../core/storage/customKeysScope.js";
import {
  LOCAL_ORG_ID,
  SHARED_ORG_ID,
  normalizeIntegrationKeyVaultAudience,
} from "../../core/storage/customKeysVault.js";

interface StoredCustomKeyRecord {
  id: string;
  name: string;
  description?: string;
  permission?: "always" | "ask";
  clientAccess?: KeyClientAccess;
  createdAt: string;
  updatedAt?: string;
  source?: "manual" | "oauth";
  managedBy?: "oauth";
  oauthProvider?: "openai" | "anthropic";
  vaultAudience?: "user" | "namespace" | "org";
}

function resolveElectronDataDir(): string {
  const home = os.homedir();

  if (process.platform === "darwin") {
    return path.join(home, "Library/Application Support/Papr Work/data");
  }

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Papr Work/data");
  }

  return path.join(home, ".config/Papr Work/data");
}

/** Legacy single-file vault (pre org scoping). */
export function resolveCustomKeysJsonPath(): string {
  return path.join(resolveElectronDataDir(), "custom-keys.json");
}

export function resolveGlobalCustomKeysJsonPath(): string {
  return path.join(resolveElectronDataDir(), "custom-keys.global.json");
}

export function resolveOrgCustomKeysJsonPath(organizationId: string): string {
  return path.join(
    resolveElectronDataDir(),
    "orgs",
    organizationId,
    "custom-keys.json",
  );
}

function mapStoredKey(
  key: StoredCustomKeyRecord,
  scope: CustomKeyMetadata["scope"],
  organizationId?: string,
): CustomKeyMetadata {
  return {
    id: key.id,
    name: key.name,
    description: key.description,
    permission: key.permission ?? "ask",
    clientAccess: normalizeKeyClientAccess(key.clientAccess),
    createdAt: key.createdAt,
    updatedAt: key.updatedAt ?? key.createdAt,
    source: key.source,
    managedBy: key.managedBy,
    oauthProvider: key.oauthProvider,
    scope,
    orgScope:
      scope === "global"
        ? "global"
        : scope === "shared"
          ? "all"
          : "organization",
    organizationId,
    vaultAudience: normalizeIntegrationKeyVaultAudience(key.vaultAudience),
  };
}

function mapStoredKeys(
  data: Record<string, StoredCustomKeyRecord>,
  scope: CustomKeyMetadata["scope"],
  organizationId?: string,
): CustomKeyMetadata[] {
  return Object.values(data).map((key) =>
    mapStoredKey(key, scope, organizationId),
  );
}

function mapLegacyStoredKeys(
  data: Record<string, StoredCustomKeyRecord>,
  organizationId: string,
): CustomKeyMetadata[] {
  return Object.values(data).map((key) => {
    const scope = isGlobalCustomKeyName(key.name) ? "global" : "org";
    return mapStoredKey(
      key,
      scope,
      scope === "org" ? organizationId : undefined,
    );
  });
}

async function readKeysMetadataFile(
  keysFile: string,
  scope: CustomKeyMetadata["scope"],
  organizationId?: string,
): Promise<CustomKeyMetadata[]> {
  try {
    const raw = await fs.readFile(keysFile, "utf8");
    const data = JSON.parse(raw) as Record<string, StoredCustomKeyRecord>;
    return mapStoredKeys(data, scope, organizationId);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function mergeKeysByName(
  ...groups: CustomKeyMetadata[][]
): CustomKeyMetadata[] {
  const merged = new Map<string, CustomKeyMetadata>();
  for (const group of groups) {
    for (const key of group) {
      merged.set(key.name.trim().toUpperCase(), key);
    }
  }
  return Array.from(merged.values());
}

export async function loadCustomKeysMetadataFromFile(): Promise<
  CustomKeyMetadata[]
> {
  const orgId = process.env.PAPR_ORG_ID?.trim() || LOCAL_ORG_ID;
  const globalKeys = await readKeysMetadataFile(
    resolveGlobalCustomKeysJsonPath(),
    "global",
  );
  const sharedKeys = await readKeysMetadataFile(
    resolveOrgCustomKeysJsonPath(SHARED_ORG_ID),
    "shared",
    SHARED_ORG_ID,
  );
  const orgKeys = orgId
    ? await readKeysMetadataFile(
        resolveOrgCustomKeysJsonPath(orgId),
        "org",
        orgId,
      )
    : [];

  if (globalKeys.length > 0 || sharedKeys.length > 0 || orgKeys.length > 0) {
    return mergeKeysByName(globalKeys, sharedKeys, orgKeys);
  }

  try {
    const raw = await fs.readFile(resolveCustomKeysJsonPath(), "utf8");
    const data = JSON.parse(raw) as Record<string, StoredCustomKeyRecord>;
    return mapLegacyStoredKeys(data, orgId);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
