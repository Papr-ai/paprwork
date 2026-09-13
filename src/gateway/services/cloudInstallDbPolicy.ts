/**
 * Install-time database policy for cloud fork vs team collaborate.
 */

import { promises as fs } from "fs";
import path from "path";
import type {
  CloudAppInstallMode,
  DatabasePolicy,
} from "../../core/types/cloudAppLineage.js";
import type { DatabaseIsolation } from "./DatabaseRegistryService.js";
import { parseDataSourcesFile } from "./appDataSources.js";
import { LINKED_DATABASES_FILENAME } from "./cloudSync/linkedDatabasesForCloud.js";

/** Runtime install pipeline policy (distinct from persisted lineage.databasePolicy). */
export type InstallDbPolicy = "shared_primary" | "fork_empty";

export class CloudInstallDbPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CloudInstallDbPolicyError";
    this.code = code;
  }
}

export function databasePolicyFromInstallPolicy(
  policy: InstallDbPolicy,
): DatabasePolicy {
  return policy === "shared_primary" ? "shared" : "forked";
}

/**
 * track + all linked sources isolation === "shared" → shared_primary
 * track + any per-user source → error (require web or fork)
 * fork → fork_empty
 */
export function resolveInstallDbPolicy(
  mode: CloudAppInstallMode,
  linkedIsolations: readonly DatabaseIsolation[],
): InstallDbPolicy {
  if (mode === "fork") {
    return "fork_empty";
  }

  if (linkedIsolations.some((isolation) => isolation === "per-user")) {
    throw new CloudInstallDbPolicyError(
      "per_user_db",
      "Collaborate install is not supported for per-user databases. Fork the app or use the web app.",
    );
  }

  return "shared_primary";
}

/** Read isolation modes for registry-linked databases in a repo checkout. */
export async function readLinkedDbIsolations(input: {
  repoPaprHome: string;
  repoAppDir: string;
}): Promise<DatabaseIsolation[]> {
  const configPath = path.join(input.repoAppDir, "data-sources.json");
  let dbIds: string[] = [];
  try {
    const raw = await fs.readFile(configPath, "utf8");
    dbIds = parseDataSourcesFile(raw).sources
      .map((source) => source.dbId?.trim())
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
  if (dbIds.length === 0) {
    return [];
  }

  const isolations = new Set<DatabaseIsolation>();
  const registryPath = path.join(input.repoPaprHome, "data", "databases.json");
  try {
    const registryRaw = await fs.readFile(registryPath, "utf8");
    const registry = JSON.parse(registryRaw) as {
      databases?: Record<string, { isolation?: DatabaseIsolation }>;
    };
    for (const dbId of dbIds) {
      const isolation = registry.databases?.[dbId]?.isolation;
      if (isolation) {
        isolations.add(isolation);
      }
    }
  } catch {
    /* no workspace registry in sparse checkout */
  }

  const linkedPath = path.join(input.repoAppDir, LINKED_DATABASES_FILENAME);
  try {
    const linkedRaw = await fs.readFile(linkedPath, "utf8");
    const linked = JSON.parse(linkedRaw) as {
      databases?: Record<string, { isolation?: DatabaseIsolation }>;
    };
    for (const dbId of dbIds) {
      const isolation = linked.databases?.[dbId]?.isolation;
      if (isolation) {
        isolations.add(isolation);
      }
    }
  } catch {
    /* no linked-databases.json */
  }

  return [...isolations];
}

export function assertTrackAllowedForCatalog(input: {
  mode: CloudAppInstallMode;
  catalogScope?: "global" | "namespace";
  visibility?: string;
}): void {
  if (input.mode !== "track") {
    return;
  }

  if (input.catalogScope === "global") {
    throw new CloudInstallDbPolicyError(
      "community_track_forbidden",
      "Community apps can only be installed as an independent copy (fork). Track/collaborate is available for team apps.",
    );
  }

  const visibility = input.visibility?.trim();
  const teamShared =
    visibility !== undefined &&
    visibility.length > 0 &&
    (visibility === "team" || visibility.startsWith("team_"));

  if (input.catalogScope === "namespace" && visibility && !teamShared) {
    throw new CloudInstallDbPolicyError(
      "non_team_track_forbidden",
      "Collaborate install requires a team-shared app. Install a fork copy instead.",
    );
  }

  if (!teamShared) {
    throw new CloudInstallDbPolicyError(
      "non_team_track_forbidden",
      "Collaborate install requires a team-shared app. Install a fork copy instead.",
    );
  }
}
