/**
 * Registry database preview + deletion when removing a mini-app.
 */

import * as fs from "fs";
import * as path from "path";
import { parseDataSourcesFile } from "./appDataSources.js";
import {
  getDatabaseRegistryService,
  initializeDatabaseRegistry,
  registrySlugFromLocalPath,
  type DatabaseRecord,
} from "./DatabaseRegistryService.js";
import { resolveLinkedSourceDbPath } from "./portableDataSources.js";
import { getPaprJobsRoot } from "../../core/utils/paprRoot.js";
import { isTursoStateDbPathInWorkspace } from "./tursoSyncState.js";

export interface LinkedRegistryDbPreview {
  dbId: string;
  alias: string;
  label: string;
  localPath: string;
  tursoShortName: string;
  sharedWithApps: Array<{ appId: string; title: string }>;
  soleLinker: boolean;
}

export interface DeleteRegistryDatabasesResult {
  deletedRegistryDbCount: number;
  deletedRegistryTursoCount: number;
}

function isSyncableRegistrySource(source: {
  type: string;
  role?: string;
  dbId?: string;
  jobId?: string;
}): boolean {
  if (source.type !== "sqlite") {
    return false;
  }
  if (source.role === "scratch") {
    return false;
  }
  return Boolean(source.dbId || source.jobId);
}

async function resolveRegistryRecord(
  dbId: string | undefined,
  dbPath: string,
): Promise<DatabaseRecord | undefined> {
  const registry = getDatabaseRegistryService();
  if (dbId) {
    const byId = registry.getById(dbId);
    if (byId && byId.status === "active") {
      return byId;
    }
  }
  const byPath = registry.getByPath(dbPath);
  if (byPath && byPath.status === "active") {
    return byPath;
  }
  return undefined;
}

/** Linked registry DBs declared in the app's data-sources.json. */
export async function buildLinkedRegistryDbPreview(
  appId: string,
  appsRootDir: string,
  resolveAppTitle: (otherAppId: string) => string,
): Promise<LinkedRegistryDbPreview[]> {
  const configPath = path.join(appsRootDir, appId, "data-sources.json");
  let raw: string;
  try {
    raw = await fs.promises.readFile(configPath, "utf8");
  } catch {
    return [];
  }

  let config;
  try {
    config = parseDataSourcesFile(raw);
  } catch {
    return [];
  }

  await initializeDatabaseRegistry();
  const registry = getDatabaseRegistryService();
  const seenDbIds = new Set<string>();
  const previews: LinkedRegistryDbPreview[] = [];

  for (const source of config.sources) {
    if (!isSyncableRegistrySource(source)) {
      continue;
    }

    const resolvedDbPath = await resolveLinkedSourceDbPath({
      dbPath: source.dbPath,
      dbId: source.dbId,
      jobId: source.jobId,
      jobsRoot: getPaprJobsRoot(),
    });
    if (!resolvedDbPath || !isTursoStateDbPathInWorkspace(resolvedDbPath)) {
      continue;
    }

    const record = await resolveRegistryRecord(source.dbId, resolvedDbPath);
    if (!record) {
      continue;
    }

    if (seenDbIds.has(record.dbId)) {
      continue;
    }
    seenDbIds.add(record.dbId);

    const referencingAppIds = await registry.listReferencingAppIds(
      record.dbId,
      record.localPath,
    );
    const otherAppIds = referencingAppIds.filter((id) => id !== appId);
    const sharedWithApps = otherAppIds.map((otherAppId) => ({
      appId: otherAppId,
      title: resolveAppTitle(otherAppId),
    }));
    const soleLinker =
      referencingAppIds.length === 1 && referencingAppIds[0] === appId;

    previews.push({
      dbId: record.dbId,
      alias: source.alias,
      label: record.label ?? source.alias,
      localPath: record.localPath,
      tursoShortName: record.tursoShortName,
      sharedWithApps,
      soleLinker,
    });
  }

  return previews;
}

async function deleteLocalRegistryDatabaseFiles(localPath: string): Promise<void> {
  const slugDir = path.dirname(localPath);
  if (!registrySlugFromLocalPath(localPath)) {
    return;
  }
  await fs.promises.rm(slugDir, { recursive: true, force: true });
}

/**
 * Tombstone + remove local files (+ optional Turso) for registry DBs only this app links.
 * Must run before the app folder is deleted so reference checks stay valid.
 */
export async function deleteSoleLinkerRegistryDatabases(
  appId: string,
  dbIds: readonly string[],
  deleteTurso: boolean,
): Promise<DeleteRegistryDatabasesResult> {
  if (dbIds.length === 0) {
    return { deletedRegistryDbCount: 0, deletedRegistryTursoCount: 0 };
  }

  await initializeDatabaseRegistry();
  const registry = getDatabaseRegistryService();

  let deletedRegistryDbCount = 0;
  let deletedRegistryTursoCount = 0;

  let tursoBridge: Awaited<
    ReturnType<typeof import("./TursoSyncBridge.js").getTursoSyncBridge>
  > | null = null;
  if (deleteTurso) {
    try {
      const { getTursoSyncBridge } = await import("./TursoSyncBridge.js");
      tursoBridge = getTursoSyncBridge();
    } catch {
      tursoBridge = null;
    }
  }

  for (const dbId of dbIds) {
    const record = registry.getById(dbId);
    if (!record || record.status !== "active") {
      continue;
    }

    const referencingAppIds = await registry.listReferencingAppIds(
      dbId,
      record.localPath,
    );
    const soleLinker =
      referencingAppIds.length === 1 && referencingAppIds[0] === appId;
    if (!soleLinker) {
      console.warn(
        `[deleteApp] Skipping registry DB ${dbId} — still linked by other app(s)`,
      );
      continue;
    }

    if (deleteTurso && tursoBridge) {
      try {
        const deleted = await tursoBridge.deleteTursoDatabaseByName(
          record.tursoShortName,
        );
        if (deleted) {
          deletedRegistryTursoCount += 1;
        }
      } catch (error) {
        console.warn(
          `[deleteApp] Could not delete Turso replica for ${dbId}:`,
          (error as Error).message,
        );
      }
    }

    await deleteLocalRegistryDatabaseFiles(record.localPath);
    await registry.tombstone(dbId);
    deletedRegistryDbCount += 1;
    console.log(`[deleteApp] Deleted registry database ${dbId} (${record.label ?? dbId})`);
  }

  return { deletedRegistryDbCount, deletedRegistryTursoCount };
}
