/**
 * Discover mini-app linked SQLite sources eligible for Turso boundary sync.
 * Only primary/readonly sources sync — scratch job tables stay local.
 */

import * as fs from "fs";
import * as path from "path";
import {
  parseDataSourcesFile,
  type AppDataSource,
  type AppDataSourceRole,
} from "./appDataSources.js";

export interface TursoLinkedSource {
  appId: string;
  jobId?: string;
  dbId?: string;
  dbPath: string;
  alias: string;
  role?: AppDataSourceRole;
}

function isSyncableRole(role: AppDataSourceRole | undefined): boolean {
  return role !== "scratch";
}

function sourceKey(source: Pick<TursoLinkedSource, "dbPath">): string {
  return path.normalize(source.dbPath);
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
      const linked: TursoLinkedSource = {
        appId: entry.name,
        ...(source.jobId ? { jobId: source.jobId } : {}),
        ...(source.dbId ? { dbId: source.dbId } : {}),
        dbPath: path.normalize(source.dbPath),
        alias: source.alias,
        role: source.role,
      };
      const key = sourceKey(linked);
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
  if (!source.dbPath) {
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
  const sources = await discoverTursoLinkedSources(appsRootDir);
  const keys = new Set<string>();
  for (const source of sources) {
    try {
      await fs.promises.access(source.dbPath, fs.constants.R_OK);
      keys.add(linkedSourceSyncKey(source));
    } catch {
      // linked path missing — skip until database file exists
    }
  }
  return [...keys];
}
