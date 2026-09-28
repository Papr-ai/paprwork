/**
 * Who may delete cloud-shared resources when removing a mini-app.
 * Collaborators (track / team shared DB) must not unpublish, delete Turso,
 * cloud job catalog entries, or publisher registry rows.
 */

import path from "path";
import { parseCloudAppLineageFile } from "../../core/utils/cloudAppLineage.js";
import type { DatabasePolicy } from "../../core/types/cloudAppLineage.js";
import { getPaprUserId } from "../utils/paprUserId.js";
import { CLOUD_LINEAGE_FILENAME } from "./CloudAppLineageService.js";
import { lookupSharedPrimaryTursoEntry } from "./sharedPrimaryTursoStore.js";
import { promises as fs } from "fs";
import type { JobGraph } from "./jobs/types.js";

export const TEAM_SHARED_REGISTRY_DELETE_MESSAGE =
  "This database is the publisher's shared team copy. Unlink it from your apps or remove your local app install instead of tombstoning the registry entry.";

export interface ResourceDeleteLocalScope {
  /** Remove local index/registry only — no cloud metadata or Turso side effects. */
  localOnly: boolean;
  linkedAppIds: string[];
  /** Non-publishers must not delete shared-primary registry / Turso rows. */
  blockDelete: boolean;
  blockReason?: string;
}

export interface AppDeleteScope {
  /** Remove this machine's copy only — no cloud or shared Turso side effects. */
  localUninstallOnly: boolean;
  installMode: "track" | "fork" | null;
  databasePolicy: DatabasePolicy | null;
  publisherUserId: string | null;
  sourceSlug: string | null;
  /**
   * Publisher is deleting a published app others may still use.
   * Show deprecation / notify-collaborators messaging in the UI.
   */
  publisherSharedDeprecation: boolean;
}

export async function resolveAppDeleteScope(
  appId: string,
  appsRootDir: string,
  isPublished: boolean,
): Promise<AppDeleteScope> {
  const empty: AppDeleteScope = {
    localUninstallOnly: false,
    installMode: null,
    databasePolicy: null,
    publisherUserId: null,
    sourceSlug: null,
    publisherSharedDeprecation: false,
  };

  const trimmedAppId = appId.trim();
  if (!trimmedAppId) {
    return empty;
  }

  let lineage = null;
  try {
    const raw = await fs.readFile(
      path.join(appsRootDir, trimmedAppId, CLOUD_LINEAGE_FILENAME),
      "utf8",
    );
    lineage = parseCloudAppLineageFile(raw);
  } catch {
    return {
      ...empty,
      publisherSharedDeprecation: isPublished,
    };
  }

  if (!lineage) {
    return {
      ...empty,
      publisherSharedDeprecation: isPublished,
    };
  }

  const currentUserId = getPaprUserId()?.trim() ?? "";
  const publisherUserId = lineage.source.userId.trim();
  const isPublisher =
    Boolean(currentUserId) && publisherUserId === currentUserId;
  const databasePolicy =
    lineage.databasePolicy ??
    (lineage.mode === "track" ? "shared" : "forked");

  const localUninstallOnly =
    Boolean(currentUserId) &&
    !isPublisher &&
    (lineage.mode === "track" || databasePolicy === "shared");

  const publisherSharedDeprecation =
    isPublisher &&
    isPublished &&
    (lineage.mode === "track" || databasePolicy === "shared");

  return {
    localUninstallOnly,
    installMode: lineage.mode,
    databasePolicy,
    publisherUserId: publisherUserId || null,
    sourceSlug: lineage.source.slug || null,
    publisherSharedDeprecation,
  };
}

/** Turso name is mapped to a publisher shared-primary segment (team/community track). */
export function isPublisherSharedPrimaryTursoName(
  tursoShortName: string,
  paprDir?: string,
): boolean {
  const entry = lookupSharedPrimaryTursoEntry(tursoShortName.trim(), paprDir);
  return entry !== null;
}

/** Only the publisher may delete Turso for a shared-primary segment. */
export function shouldBlockTursoDeleteForSharedPrimary(
  tursoShortName: string,
  paprDir?: string,
): boolean {
  const entry = lookupSharedPrimaryTursoEntry(tursoShortName.trim(), paprDir);
  if (!entry) {
    return false;
  }
  const currentUserId = getPaprUserId()?.trim() ?? "";
  if (!currentUserId) {
    return true;
  }
  return entry.publisherUserId.trim() !== currentUserId;
}

export function sanitizeDeleteAppOptionsForScope(
  scope: AppDeleteScope,
  options: {
    unpublishFromCloud?: boolean;
    deleteLinkedJobs?: boolean;
    deleteTursoDatabases?: boolean;
    deleteRegistryDbIds?: string[];
    deleteRegistryTurso?: boolean;
  },
): {
  unpublishFromCloud: boolean;
  deleteLinkedJobs: boolean;
  deleteTursoDatabases: boolean;
  deleteRegistryDbIds: string[];
  deleteRegistryTurso: boolean;
} {
  if (!scope.localUninstallOnly) {
    return {
      unpublishFromCloud: options.unpublishFromCloud === true,
      deleteLinkedJobs: options.deleteLinkedJobs === true,
      deleteTursoDatabases: options.deleteTursoDatabases === true,
      deleteRegistryDbIds: options.deleteRegistryDbIds ?? [],
      deleteRegistryTurso: options.deleteRegistryTurso === true,
    };
  }

  return {
    unpublishFromCloud: false,
    deleteLinkedJobs: false,
    deleteTursoDatabases: false,
    deleteRegistryDbIds: [],
    deleteRegistryTurso: false,
  };
}

async function resolveLocalOnlyFromLinkedApps(
  appIds: string[],
  appsRootDir: string,
): Promise<Pick<ResourceDeleteLocalScope, "localOnly" | "linkedAppIds">> {
  const linkedAppIds = [...new Set(appIds.map((id) => id.trim()).filter(Boolean))];
  if (linkedAppIds.length === 0) {
    return { localOnly: false, linkedAppIds: [] };
  }

  let hasCollaboratorScope = false;
  let hasPublisherFullScope = false;
  for (const linkedAppId of linkedAppIds) {
    const scope = await resolveAppDeleteScope(linkedAppId, appsRootDir, false);
    if (scope.localUninstallOnly) {
      hasCollaboratorScope = true;
    } else {
      hasPublisherFullScope = true;
    }
  }

  return {
    localOnly: hasCollaboratorScope && !hasPublisherFullScope,
    linkedAppIds,
  };
}

/** Standalone job delete — mirror app uninstall scope for linked track/shared installs. */
export async function resolveJobDeleteScope(
  jobId: string,
  options: {
    graph: JobGraph | null;
    jobAppIds?: string[] | null;
    appsRootDir: string;
  },
): Promise<ResourceDeleteLocalScope> {
  const trimmedJobId = jobId.trim();
  const appIdSet = new Set<string>();
  for (const appId of options.jobAppIds ?? []) {
    const trimmed = appId.trim();
    if (trimmed) {
      appIdSet.add(trimmed);
    }
  }
  if (options.graph?.appLinks) {
    for (const [appId, link] of Object.entries(options.graph.appLinks)) {
      if (link.jobIds.includes(trimmedJobId)) {
        appIdSet.add(appId);
      }
    }
  }

  const base = await resolveLocalOnlyFromLinkedApps([...appIdSet], options.appsRootDir);
  return { ...base, blockDelete: false };
}

/** Standalone registry database delete — block shared-primary for non-publishers. */
export async function resolveDatabaseDeleteScope(
  tursoShortName: string,
  referencingAppIds: string[],
  appsRootDir: string,
  paprDir?: string,
): Promise<ResourceDeleteLocalScope> {
  if (shouldBlockTursoDeleteForSharedPrimary(tursoShortName, paprDir)) {
    return {
      localOnly: true,
      linkedAppIds: referencingAppIds,
      blockDelete: true,
      blockReason: TEAM_SHARED_REGISTRY_DELETE_MESSAGE,
    };
  }

  const base = await resolveLocalOnlyFromLinkedApps(
    referencingAppIds,
    appsRootDir,
  );
  return { ...base, blockDelete: false };
}
