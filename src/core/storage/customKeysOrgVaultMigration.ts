/**
 * One-time migration: org vaults seeded from _local were full copies.
 * Non-primary orgs keep only PAPR_API_KEY (namespace-specific).
 */

import fs from "fs/promises";
import path from "path";
import type { CustomKey } from "./CustomKeysStorage.js";
import {
  dedupeCustomKeysByName,
  pickNewestCustomKeyByName,
} from "./customKeysDedupe.js";

import { LOCAL_ORG_ID, SHARED_ORG_ID } from "./customKeysVault.js";
export const ORG_VAULT_ISOLATION_MARKER = ".org-vault-isolation-v1.json";
const PAPR_API_KEY = "PAPR_API_KEY";

export interface OrgVaultMigrationResult {
  ran: boolean;
  primaryOrganizationId?: string;
  strippedOrganizations: string[];
}

function normalizeStoredKeys(
  data: Record<string, CustomKey>,
): Map<string, CustomKey> {
  return new Map(Object.entries(data));
}

async function readOrgKeysMap(keysFile: string): Promise<Map<string, CustomKey>> {
  try {
    const fileContent = await fs.readFile(keysFile, "utf-8");
    const data = JSON.parse(fileContent) as Record<string, CustomKey>;
    return normalizeStoredKeys(data);
  } catch {
    return new Map();
  }
}

async function writeOrgKeysMap(
  keysFile: string,
  keys: Map<string, CustomKey>,
): Promise<void> {
  const tempFile = `${keysFile}.tmp`;
  await fs.mkdir(path.dirname(keysFile), { recursive: true });
  await fs.writeFile(tempFile, JSON.stringify(Object.fromEntries(keys), null, 2), "utf-8");
  await fs.rename(tempFile, keysFile);
}

/** True when an org vault is a byte-for-byte copy of the _local key id set. */
export function isVaultClonedFromLocal(
  localKeyIds: ReadonlySet<string>,
  orgKeys: ReadonlyMap<string, CustomKey>,
): boolean {
  if (localKeyIds.size === 0 || orgKeys.size === 0) {
    return false;
  }

  if (orgKeys.size !== localKeyIds.size) {
    return false;
  }

  for (const id of orgKeys.keys()) {
    if (!localKeyIds.has(id)) {
      return false;
    }
  }

  return true;
}

/** Keep only the newest PAPR_API_KEY after removing a blind _local copy. */
export function stripClonedOrgVault(
  orgKeys: ReadonlyMap<string, CustomKey>,
): Map<string, CustomKey> {
  const paprKey = pickNewestCustomKeyByName(orgKeys.values(), PAPR_API_KEY);
  const stripped = new Map<string, CustomKey>();
  if (paprKey) {
    stripped.set(paprKey.id, paprKey);
  }
  return stripped;
}

function orgKeysPath(dataDir: string, organizationId: string): string {
  return path.join(dataDir, "orgs", organizationId, "custom-keys.json");
}

export async function migrateOrgVaultIsolation(
  dataDir: string,
  primaryOrganizationId?: string,
): Promise<OrgVaultMigrationResult> {
  const markerPath = path.join(dataDir, ORG_VAULT_ISOLATION_MARKER);
  try {
    await fs.access(markerPath);
    return { ran: false, strippedOrganizations: [] };
  } catch {
    // First run — apply migration.
  }

  const localKeys = await readOrgKeysMap(orgKeysPath(dataDir, LOCAL_ORG_ID));
  dedupeCustomKeysByName(localKeys);
  const localKeyIds = new Set(localKeys.keys());
  const strippedOrganizations: string[] = [];

  const primaryOrg = primaryOrganizationId?.trim() || LOCAL_ORG_ID;
  const orgsDir = path.join(dataDir, "orgs");

  let orgIds: string[] = [];
  try {
    const entries = await fs.readdir(orgsDir, { withFileTypes: true });
    orgIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    orgIds = [];
  }

  for (const orgId of orgIds) {
    if (orgId === LOCAL_ORG_ID || orgId === SHARED_ORG_ID) {
      continue;
    }

    const keysFile = orgKeysPath(dataDir, orgId);
    const orgKeys = await readOrgKeysMap(keysFile);
    dedupeCustomKeysByName(orgKeys);

    if (!isVaultClonedFromLocal(localKeyIds, orgKeys)) {
      continue;
    }

    if (orgId === primaryOrg) {
      console.log(
        `[CustomKeys] Keeping full vault for primary org ${orgId} (${orgKeys.size} keys)`,
      );
      continue;
    }

    const stripped = stripClonedOrgVault(orgKeys);
    await writeOrgKeysMap(keysFile, stripped);
    strippedOrganizations.push(orgId);
    console.log(
      `[CustomKeys] Stripped cloned vault for org ${orgId}: kept ${stripped.size} key(s)`,
    );
  }

  await fs.writeFile(
    markerPath,
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        primaryOrganizationId: primaryOrg,
        strippedOrganizations,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return {
    ran: true,
    primaryOrganizationId: primaryOrg,
    strippedOrganizations,
  };
}
