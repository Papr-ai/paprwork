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
 * Install mode is about CODE lineage; this function decides DATA.
 *
 * The two were conflated: "track" always meant "attach the publisher's
 * primary database", which is correct inside a team and unacceptable across
 * the public Community catalog — so collaborating on a community app was
 * banned outright, leaving fork as the only option. That is why contributors
 * ended up with a detached copy when what they wanted was to help build the
 * original.
 *
 * Splitting the axes fixes it:
 *   fork                     → fork_empty     (no lineage, own data)
 *   track + team app         → shared_primary (teammates share one database)
 *   track + community app    → fork_empty     (own data, upstream code link)
 *
 * Community collaborate therefore keeps the lineage that powers Get updates
 * and Propose changes, while every installer still gets their own rows. The
 * publisher's data is never exposed to the public catalog.
 */
function assertPerUserTrackAllowed(
  linkedIsolations: readonly DatabaseIsolation[],
): void {
  if (linkedIsolations.some((isolation) => isolation === "per-user")) {
    throw new CloudInstallDbPolicyError(
      "per_user_db",
      "Collaborate install is not supported for per-user databases. Fork the app or use the web app.",
    );
  }
}

function assertExplicitInstallDbPolicyAllowed(input: {
  mode: CloudAppInstallMode;
  catalogScope?: "global" | "namespace";
  explicitPolicy: InstallDbPolicy;
}): void {
  if (input.mode === "fork") {
    if (input.explicitPolicy !== "fork_empty") {
      throw new CloudInstallDbPolicyError(
        "invalid_install_db_policy",
        "Install a copy always uses a private empty database.",
      );
    }
    return;
  }

  if (input.catalogScope === "global") {
    if (input.explicitPolicy !== "fork_empty") {
      throw new CloudInstallDbPolicyError(
        "invalid_install_db_policy",
        "Community collaborate never shares the publisher's database.",
      );
    }
    return;
  }

  if (
    input.explicitPolicy !== "fork_empty" &&
    input.explicitPolicy !== "shared_primary"
  ) {
    throw new CloudInstallDbPolicyError(
      "invalid_install_db_policy",
      "Team collaborate must use private data or the shared team database.",
    );
  }
}

export function resolveInstallDbPolicy(
  mode: CloudAppInstallMode,
  linkedIsolations: readonly DatabaseIsolation[],
  catalogScope?: "global" | "namespace",
  explicitPolicy?: InstallDbPolicy,
): InstallDbPolicy {
  if (mode === "fork") {
    return "fork_empty";
  }

  if (explicitPolicy) {
    assertExplicitInstallDbPolicyAllowed({
      mode,
      catalogScope,
      explicitPolicy,
    });
    assertPerUserTrackAllowed(linkedIsolations);
    return explicitPolicy;
  }

  if (catalogScope === "global") {
    return "fork_empty";
  }

  assertPerUserTrackAllowed(linkedIsolations);

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

  // Community collaborate is allowed because it no longer implies a shared
  // database — resolveInstallDbPolicy forces fork_empty for global scope, so
  // the only thing tracked is code. What was being blocked here was the data
  // leak, not the collaboration.
  if (input.catalogScope === "global") {
    return;
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
