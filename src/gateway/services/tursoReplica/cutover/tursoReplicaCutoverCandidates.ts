/**
 * Which legacy registry databases are eligible for auto-cutover.
 */

import type { DatabaseRecord } from "../../DatabaseRegistryService.js";
import {
  getDatabaseRegistryService,
  initializeDatabaseRegistry,
} from "../../DatabaseRegistryService.js";
import { discoverTursoLinkedSources } from "../../tursoLinkedSources.js";
import { ensureTursoSyncBridge } from "../../TursoSyncBridge.js";

/** Legacy registry DBs linked from an active mini-app data-sources.json. */
export async function listLinkedLegacyCutoverCandidates(options?: {
  dbId?: string;
}): Promise<DatabaseRecord[]> {
  await initializeDatabaseRegistry();
  const registry = getDatabaseRegistryService();

  let candidates = registry.listActive().filter(
    (record) => record.syncMode !== "replica",
  );

  if (options?.dbId) {
    candidates = candidates.filter((record) => record.dbId === options.dbId);
  }

  const bridge = ensureTursoSyncBridge();
  const appsRoot = bridge.getAppsRootDir();
  const linkedSources = await discoverTursoLinkedSources(appsRoot);

  const linkedDbIds = new Set<string>();
  const linkedJobIds = new Set<string>();
  for (const source of linkedSources) {
    if (source.dbId) {
      linkedDbIds.add(source.dbId);
    }
    if (source.jobId) {
      linkedJobIds.add(source.jobId);
    }
  }

  return candidates.filter(
    (record) =>
      linkedDbIds.has(record.dbId) ||
      (record.ownerJobId !== undefined && linkedJobIds.has(record.ownerJobId)),
  );
}

export interface LinkedCutoverAppRef {
  appId: string;
  alias: string;
}

/** Mini-apps that link a registry dbId or owner job (for dry-run / dogfood visibility). */
export async function listAppsLinkingRegistryDb(
  dbId: string,
  options?: { ownerJobId?: string },
): Promise<LinkedCutoverAppRef[]> {
  const bridge = ensureTursoSyncBridge();
  const appsRoot = bridge.getAppsRootDir();
  const linkedSources = await discoverTursoLinkedSources(appsRoot);
  const refs: LinkedCutoverAppRef[] = [];
  const seen = new Set<string>();

  for (const source of linkedSources) {
    const matchesDb =
      source.dbId === dbId ||
      (options?.ownerJobId !== undefined &&
        source.jobId === options.ownerJobId);
    if (!matchesDb) {
      continue;
    }
    const key = `${source.appId}:${source.alias}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push({ appId: source.appId, alias: source.alias });
  }
  return refs;
}

/** Legacy registry DBs linked from one mini-app (Upload now cutover scope). */
export async function listLegacyCutoverCandidatesForApp(
  appId: string,
): Promise<DatabaseRecord[]> {
  const bridge = ensureTursoSyncBridge();
  const appsRoot = bridge.getAppsRootDir();
  const linkedSources = await discoverTursoLinkedSources(appsRoot);

  const appDbIds = new Set<string>();
  const appJobIds = new Set<string>();
  for (const source of linkedSources) {
    if (source.appId !== appId) {
      continue;
    }
    if (source.dbId) {
      appDbIds.add(source.dbId);
    }
    if (source.jobId) {
      appJobIds.add(source.jobId);
    }
  }

  if (appDbIds.size === 0 && appJobIds.size === 0) {
    return [];
  }

  const candidates = await listLinkedLegacyCutoverCandidates();
  return candidates.filter(
    (record) =>
      appDbIds.has(record.dbId) ||
      (record.ownerJobId !== undefined && appJobIds.has(record.ownerJobId)),
  );
}
