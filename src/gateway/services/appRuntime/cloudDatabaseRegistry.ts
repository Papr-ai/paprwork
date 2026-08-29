/**
 * Hydrate the database registry on Cloud App Host from git-synced databases.json.
 *
 * Desktop stores registry at ~/Papr/.../data/databases.json and syncs via git.
 * Cloud host has no local Papr tree — it must load the registry from the repo
 * before TursoDbAdapter can resolve dbId → Turso short name.
 */

import {
  DATABASES_REGISTRY_FILENAME,
  getDatabaseRegistryService,
} from "../DatabaseRegistryService.js";
import { LINKED_DATABASES_FILENAME } from "../cloudSync/linkedDatabasesForCloud.js";
import { parseDataSourcesFile, type AppDataSourcesFile } from "../appDataSources.js";
import {
  fetchCachedRuntimeRepoFile,
  invalidateAppDbConfigCacheForApp,
  readAppDbConfigCache,
  resolveAppCacheRevision,
  writeAppDbConfigCache,
} from "./cloudAppHostCache.js";
import type { AppRuntimeRouteAuth } from "./types.js";

export interface LoadAppDataSourcesStats {
  cacheHit?: boolean;
}

const REGISTRY_REPO_PATH = `data/${DATABASES_REGISTRY_FILENAME}`;
const DATA_SOURCES_FILENAME = "data-sources.json";

function mergeRegistryFiles(
  registry: ReturnType<typeof getDatabaseRegistryService>,
  linkedContent: string | undefined,
  databasesContent: string | undefined,
  config?: AppDataSourcesFile,
): void {
  if (linkedContent) {
    registry.mergeFromRegistryFile(linkedContent);
  }
  if (databasesContent) {
    registry.mergeFromRegistryFile(databasesContent);
  }
  if (config?.sources?.length) {
    for (const source of config.sources) {
      if (!source.dbPath) {
        continue;
      }
      registry.ensureRecordForSource(source);
    }
  }
}

function sourcesMissingRegistry(config: AppDataSourcesFile): boolean {
  const registry = getDatabaseRegistryService();
  return config.sources.some((source) => {
    if (source.role === "scratch") {
      return false;
    }
    if (!source.dbId?.trim()) {
      return false;
    }
    return registry.getById(source.dbId) === undefined;
  });
}

async function fetchDbConfigBundle(
  runtimeAuth: AppRuntimeRouteAuth,
  requestedPath: string,
  bypassFresh: boolean,
): Promise<{
  dataSourcesFile: { content: string; contentType: string } | null;
  linked: { content: string; contentType: string } | null;
  databasesFile: { content: string; contentType: string } | null;
}> {
  const fetchOpts = bypassFresh ? { bypassFresh: true as const } : undefined;
  const [dataSourcesFile, linked, databasesFile] = await Promise.all([
    fetchCachedRuntimeRepoFile(runtimeAuth, requestedPath, fetchOpts),
    fetchCachedRuntimeRepoFile(runtimeAuth, LINKED_DATABASES_FILENAME, fetchOpts),
    fetchCachedRuntimeRepoFile(runtimeAuth, REGISTRY_REPO_PATH, fetchOpts),
  ]);
  return { dataSourcesFile, linked, databasesFile };
}

/**
 * Load data-sources.json and hydrate registry files in one parallel fetch burst.
 */
export async function loadAppDataSourcesConfig(
  runtimeAuth: AppRuntimeRouteAuth,
  requestedPath = DATA_SOURCES_FILENAME,
  stats?: LoadAppDataSourcesStats,
  options?: { bypassFresh?: boolean },
): Promise<AppDataSourcesFile> {
  const registry = getDatabaseRegistryService();
  const revision = await resolveAppCacheRevision(
    runtimeAuth,
    options?.bypassFresh === true,
  );
  if (!options?.bypassFresh) {
    const cached = readAppDbConfigCache(
      runtimeAuth.namespaceId,
      runtimeAuth.slug,
      revision,
    );
    if (cached && cached.config.sources.length > 0) {
      mergeRegistryFiles(
        registry,
        cached.linkedContent,
        cached.databasesContent,
        cached.config,
      );
      if (!sourcesMissingRegistry(cached.config)) {
        if (stats) {
          stats.cacheHit = true;
        }
        return cached.config;
      }
    }
  }

  if (stats) {
    stats.cacheHit = false;
  }

  let { dataSourcesFile, linked, databasesFile } = await fetchDbConfigBundle(
    runtimeAuth,
    requestedPath,
    options?.bypassFresh === true,
  );

  if (!dataSourcesFile?.content) {
    mergeRegistryFiles(registry, linked?.content, databasesFile?.content);
    return { sources: [] };
  }

  let config = parseDataSourcesFile(dataSourcesFile.content);
  mergeRegistryFiles(registry, linked?.content, databasesFile?.content, config);

  if (sourcesMissingRegistry(config)) {
    ({ dataSourcesFile, linked, databasesFile } = await fetchDbConfigBundle(
      runtimeAuth,
      requestedPath,
      true,
    ));
    if (dataSourcesFile?.content) {
      config = parseDataSourcesFile(dataSourcesFile.content);
      mergeRegistryFiles(registry, linked?.content, databasesFile?.content, config);
    }
  }

  writeAppDbConfigCache(
    runtimeAuth.namespaceId,
    runtimeAuth.slug,
    revision,
    {
      config,
      linkedContent: linked?.content,
      databasesContent: databasesFile?.content,
    },
  );
  return config;
}

/** Bust cached db config and reload from origin (db-token retry / stale snapshot repair). */
export async function refreshAppDataSourcesConfig(
  runtimeAuth: AppRuntimeRouteAuth,
  requestedPath = DATA_SOURCES_FILENAME,
): Promise<AppDataSourcesFile> {
  invalidateAppDbConfigCacheForApp(runtimeAuth.namespaceId, runtimeAuth.slug);
  return loadAppDataSourcesConfig(runtimeAuth, requestedPath, undefined, {
    bypassFresh: true,
  });
}

export async function hydrateCloudDatabaseRegistry(
  runtimeAuth: AppRuntimeRouteAuth,
  config?: AppDataSourcesFile,
): Promise<void> {
  const registry = getDatabaseRegistryService();

  const [linked, databasesFile] = await Promise.all([
    fetchCachedRuntimeRepoFile(runtimeAuth, LINKED_DATABASES_FILENAME),
    fetchCachedRuntimeRepoFile(runtimeAuth, REGISTRY_REPO_PATH),
  ]);

  mergeRegistryFiles(
    registry,
    linked?.content,
    databasesFile?.content,
    config,
  );
}
