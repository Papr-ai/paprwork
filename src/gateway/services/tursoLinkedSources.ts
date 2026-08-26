/**
 * Discover mini-app linked SQLite sources eligible for Turso boundary sync.
 * Only primary/readonly sources sync — scratch job tables stay local.
 */

import * as fs from "fs";
import * as path from "path";
import { getPaprJobsRoot } from "../../core/utils/paprRoot.js";
import {
  isBidirectionalWriteAuthority,
  parseDataSourcesFile,
  type AppDataSource,
  type AppDataSourceRole,
  type WriteAuthority,
} from "./appDataSources.js";
import { resolveLinkedSourceDbPath } from "./portableDataSources.js";
import { getDatabaseRegistryService } from "./DatabaseRegistryService.js";
import { jobTursoDatabaseName } from "./tursoDatabaseNaming.js";
import { isTursoStateDbPathInWorkspace } from "./tursoSyncState.js";

export interface TursoLinkedSource {
  appId: string;
  jobId?: string;
  dbId?: string;
  dbPath: string;
  alias: string;
  role?: AppDataSourceRole;
  writeAuthority?: WriteAuthority;
}

export { isBidirectionalWriteAuthority };

function isSyncableRole(role: AppDataSourceRole | undefined): boolean {
  return role !== "scratch";
}

/** One entry per app+dbPath — shared registry DBs appear once per linking app. */
function appSourceKey(source: Pick<TursoLinkedSource, "appId" | "dbPath">): string {
  return `${source.appId}:${path.normalize(source.dbPath)}`;
}

/** One entry per syncKey — use before Turso push/pull to avoid double-shipping the same DB. */
export function dedupeLinkedSourcesBySyncKey(
  sources: readonly TursoLinkedSource[],
): TursoLinkedSource[] {
  const bySyncKey = new Map<string, TursoLinkedSource>();
  for (const source of sources) {
    const syncKey = linkedSourceSyncKey(source);
    if (!bySyncKey.has(syncKey)) {
      bySyncKey.set(syncKey, source);
    }
  }
  return [...bySyncKey.values()];
}

/** All app IDs that link the same on-disk SQLite file (shared registry DBs). */
export function listAppsLinkingDbPath(
  sources: readonly TursoLinkedSource[],
  dbPath: string,
): string[] {
  const normalized = path.normalize(dbPath);
  const appIds = new Set<string>();
  for (const source of sources) {
    if (path.normalize(source.dbPath) === normalized) {
      appIds.add(source.appId);
    }
  }
  return [...appIds].sort();
}

export async function discoverTursoLinkedSources(
  appsRootDir: string,
): Promise<TursoLinkedSource[]> {
  if (!fs.existsSync(appsRootDir)) {
    return [];
  }

  const entries = await fs.promises.readdir(appsRootDir, { withFileTypes: true });
  const byKey = new Map<string, TursoLinkedSource>();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dataSourcesPath = path.join(appsRootDir, entry.name, "data-sources.json");
    let raw: string;
    try {
      raw = await fs.promises.readFile(dataSourcesPath, "utf8");
    } catch {
      continue;
    }

    let config;
    try {
      config = parseDataSourcesFile(raw);
    } catch {
      continue;
    }

    for (const source of config.sources) {
      if (!isSyncableSource(source)) {
        continue;
      }

      const resolvedDbPath = await resolveLinkedSourceDbPath({
        dbPath: source.dbPath,
        dbId: source.dbId,
        jobId: source.jobId,
        jobsRoot: getPaprJobsRoot(),
      });
      if (!resolvedDbPath) {
        continue;
      }

      if (!isTursoStateDbPathInWorkspace(resolvedDbPath)) {
        continue;
      }

      const linked: TursoLinkedSource = {
        appId: entry.name,
        ...(source.jobId ? { jobId: source.jobId } : {}),
        ...(source.dbId ? { dbId: source.dbId } : {}),
        dbPath: path.normalize(resolvedDbPath),
        alias: source.alias,
        role: source.role,
        ...(source.writeAuthority ? { writeAuthority: source.writeAuthority } : {}),
      };
      const key = appSourceKey(linked);
      if (!byKey.has(key)) {
        byKey.set(key, linked);
      }
    }
  }

  return [...byKey.values()];
}

function isSyncableSource(source: AppDataSource): boolean {
  if (source.type !== "sqlite") {
    return false;
  }
  if (!source.jobId && !source.dbId) {
    return false;
  }
  return isSyncableRole(source.role);
}

export function linkedSourceSyncKey(source: TursoLinkedSource): string {
  return source.dbId ?? source.jobId ?? path.normalize(source.dbPath);
}

/** Sync keys (+ alternates) for Turso-linked sources declared by one app. */
export function listAppLinkedSyncKeys(
  appId: string,
  paprDir: string,
): Set<string> {
  const keys = new Set<string>();
  const dataSourcesPath = path.join(paprDir, "apps", appId, "data-sources.json");
  let raw: string;
  try {
    raw = fs.readFileSync(dataSourcesPath, "utf8");
  } catch {
    return keys;
  }

  let config;
  try {
    config = parseDataSourcesFile(raw);
  } catch {
    return keys;
  }

  for (const source of config.sources) {
    if (!isSyncableSource(source)) {
      continue;
    }
    const syncKey = source.dbId ?? source.jobId;
    if (!syncKey) {
      continue;
    }
    keys.add(syncKey);
    if (source.jobId && source.jobId !== syncKey) {
      keys.add(source.jobId);
    }
    if (source.dbId && source.dbId !== syncKey) {
      keys.add(source.dbId);
    }
  }

  return keys;
}

/** Other sync-state keys for the same linked DB (registry dbId vs job UUID). */
export function linkedSourceAlternateKeys(source: TursoLinkedSource): string[] {
  const syncKey = linkedSourceSyncKey(source);
  const keys: string[] = [];
  if (source.jobId && source.jobId !== syncKey) {
    keys.push(source.jobId);
  }
  if (source.dbId && source.dbId !== syncKey) {
    keys.push(source.dbId);
  }
  return keys;
}

export function resolveTursoDatabaseLabel(source: TursoLinkedSource): string {
  const registry = getDatabaseRegistryService();
  if (source.dbId) {
    const record = registry.getById(source.dbId);
    if (record) {
      return record.tursoShortName;
    }
  }
  const byPath = registry.getByPath(source.dbPath);
  if (byPath) {
    return byPath.tursoShortName;
  }
  if (source.jobId) {
    return jobTursoDatabaseName(source.jobId);
  }
  throw new Error(`Could not resolve Turso database for source alias "${source.alias}".`);
}

export function resolveLinkedSourcesForTursoPush(
  sources: readonly TursoLinkedSource[],
  options: {
    appId?: string;
    jobId?: string;
    alias?: string;
    tursoDatabase?: string;
  },
): TursoLinkedSource[] {
  const appId = options.appId?.trim();
  const jobId = options.jobId?.trim();
  const alias = options.alias?.trim();
  const tursoDatabase = options.tursoDatabase?.trim();

  if (tursoDatabase) {
    const matches = sources.filter(
      (source) => resolveTursoDatabaseLabel(source) === tursoDatabase,
    );
    if (matches.length === 0) {
      throw new Error(`No linked source for Turso database "${tursoDatabase}".`);
    }
    return matches;
  }

  if (appId && alias) {
    const match = sources.find(
      (source) => source.appId === appId && source.alias === alias,
    );
    if (!match) {
      throw new Error(
        `No linked database alias "${alias}" for app ${appId}. Check data-sources.json.`,
      );
    }
    return [match];
  }

  if (appId) {
    return sources.filter((source) => source.appId === appId);
  }

  if (jobId) {
    const match = findLinkedSourceForJob(sources, jobId);
    return match ? [match] : [];
  }

  return [];
}

export function findLinkedSourceForJob(
  sources: readonly TursoLinkedSource[],
  syncKey: string,
): TursoLinkedSource | undefined {
  return sources.find(
    (source) =>
      source.jobId === syncKey ||
      source.dbId === syncKey ||
      linkedSourceSyncKey(source) === syncKey,
  );
}

export async function listLinkedJobIdsForTursoSync(
  appsRootDir: string,
): Promise<string[]> {
  const sources = dedupeLinkedSourcesBySyncKey(
    await discoverTursoLinkedSources(appsRootDir),
  );
  const keys = new Set<string>();
  for (const source of sources) {
    if (source.dbId || source.jobId) {
      keys.add(linkedSourceSyncKey(source));
      continue;
    }
    try {
      await fs.promises.access(source.dbPath, fs.constants.R_OK);
      keys.add(linkedSourceSyncKey(source));
    } catch {
      // linked path missing — skip until database file exists
    }
  }
  return [...keys];
}
