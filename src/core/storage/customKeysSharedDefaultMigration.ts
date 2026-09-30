/**
 * One-time migration: promote org-scoped integration keys to the shared vault
 * so they are visible in every organization until the user scopes them manually.
 */

import fs from "fs/promises";
import path from "path";
import type { CustomKey } from "./CustomKeysStorage.js";
import {
  isGlobalCustomKeyName,
  isPaprPlatformApiKeyName,
} from "./customKeysScope.js";
import { dedupeCustomKeysByName } from "./customKeysDedupe.js";
import { SHARED_ORG_ID } from "./customKeysVault.js";

export const INTEGRATION_KEYS_SHARED_DEFAULT_MARKER =
  ".integration-keys-shared-default-v1.json";

export interface IntegrationKeysSharedDefaultMigrationResult {
  ran: boolean;
  promotedKeyCount: number;
  sourceOrganizations: string[];
}

function orgKeysPath(dataDir: string, organizationId: string): string {
  return path.join(dataDir, "orgs", organizationId, "custom-keys.json");
}

async function readOrgKeysMap(keysFile: string): Promise<Map<string, CustomKey>> {
  try {
    const fileContent = await fs.readFile(keysFile, "utf-8");
    const data = JSON.parse(fileContent) as Record<string, CustomKey>;
    return new Map(Object.entries(data));
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
  await fs.writeFile(
    tempFile,
    JSON.stringify(Object.fromEntries(keys), null, 2),
    "utf-8",
  );
  await fs.rename(tempFile, keysFile);
}

function normalizeKeyName(name: string): string {
  return name.trim().toUpperCase();
}

/** Merge incoming keys into shared vault; newest updatedAt wins per name. */
function mergeIntoSharedVault(
  sharedKeys: Map<string, CustomKey>,
  incoming: Iterable<[string, CustomKey]>,
): number {
  let promoted = 0;

  for (const [id, key] of incoming) {
    if (isGlobalCustomKeyName(key.name) || isPaprPlatformApiKeyName(key.name)) {
      continue;
    }

    promoted += 1;
    const normalized = normalizeKeyName(key.name);
    let existingId: string | undefined;
    let existingKey: CustomKey | undefined;

    for (const [candidateId, candidate] of sharedKeys) {
      if (normalizeKeyName(candidate.name) === normalized) {
        if (
          !existingKey ||
          candidate.updatedAt.localeCompare(existingKey.updatedAt) > 0
        ) {
          existingId = candidateId;
          existingKey = candidate;
        }
      }
    }

    if (
      !existingKey ||
      key.updatedAt.localeCompare(existingKey.updatedAt) >= 0
    ) {
      if (existingId !== undefined) {
        sharedKeys.delete(existingId);
      }
      sharedKeys.set(id, key);
    }
  }

  return promoted;
}

export async function migrateIntegrationKeysToSharedDefault(
  dataDir: string,
): Promise<IntegrationKeysSharedDefaultMigrationResult> {
  const markerPath = path.join(dataDir, INTEGRATION_KEYS_SHARED_DEFAULT_MARKER);
  try {
    await fs.access(markerPath);
    return { ran: false, promotedKeyCount: 0, sourceOrganizations: [] };
  } catch {
    // First run — apply migration.
  }

  const sharedPath = orgKeysPath(dataDir, SHARED_ORG_ID);
  const sharedKeys = await readOrgKeysMap(sharedPath);
  let promotedKeyCount = 0;
  const sourceOrganizations: string[] = [];

  const orgsDir = path.join(dataDir, "orgs");
  let orgIds: string[] = [];
  try {
    const entries = await fs.readdir(orgsDir, { withFileTypes: true });
    orgIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    orgIds = [];
  }

  for (const orgId of orgIds) {
    if (orgId === SHARED_ORG_ID) {
      continue;
    }

    const keysFile = orgKeysPath(dataDir, orgId);
    const orgKeys = await readOrgKeysMap(keysFile);
    if (orgKeys.size === 0) {
      continue;
    }

    const integrationEntries = [...orgKeys.entries()].filter(
      ([, key]) =>
        !isGlobalCustomKeyName(key.name) && !isPaprPlatformApiKeyName(key.name),
    );
    if (integrationEntries.length === 0) {
      continue;
    }

    promotedKeyCount += mergeIntoSharedVault(sharedKeys, integrationEntries);

    for (const [id] of integrationEntries) {
      orgKeys.delete(id);
    }

    dedupeCustomKeysByName(sharedKeys);
    await writeOrgKeysMap(keysFile, orgKeys);
    sourceOrganizations.push(orgId);
    console.log(
      `[CustomKeys] Promoted ${integrationEntries.length} integration key(s) from org ${orgId} to shared vault`,
    );
  }

  dedupeCustomKeysByName(sharedKeys);
  await writeOrgKeysMap(sharedPath, sharedKeys);

  await fs.writeFile(
    markerPath,
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        promotedKeyCount,
        sourceOrganizations,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return {
    ran: true,
    promotedKeyCount,
    sourceOrganizations,
  };
}
