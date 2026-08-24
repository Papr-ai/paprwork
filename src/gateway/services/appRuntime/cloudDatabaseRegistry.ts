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

/**
 * Load data-sources.json and hydrate registry files in one parallel fetch burst.
 */
export async function loadAppDataSourcesConfig(
  runtimeAuth: AppRuntimeRouteAuth,
  requestedPath = DATA_SOURCES_FILENAME,
  stats?: LoadAppDataSourcesStats,
): Promise<AppDataSourcesFile> {
  const registry = getDatabaseRegistryService();
  const revision = await resolveAppCacheRevision(runtimeAuth);
  const cached = readAppDbConfigCache(
    runtimeAuth.namespaceId,
    runtimeAuth.slug,
    revision,
  );
  if (cached && cached.config.sources.length > 0) {
    if (stats) {
      stats.cacheHit = true;
    }
    mergeRegistryFiles(
      registry,
      cached.linkedContent,
      cached.databasesContent,
      cached.config,
    );
    return cached.config;
  }

  if (stats) {
    stats.cacheHit = false;
  }

  const [dataSourcesFile, linked, databasesFile] = await Promise.all([
    fetchCachedRuntimeRepoFile(runtimeAuth, requestedPath),
    fetchCachedRuntimeRepoFile(runtimeAuth, LINKED_DATABASES_FILENAME),
    fetchCachedRuntimeRepoFile(runtimeAuth, REGISTRY_REPO_PATH),
  ]);

  if (!dataSourcesFile?.content) {
    mergeRegistryFiles(
      registry,
      linked?.content,
      databasesFile?.content,
    );
    // Do not cache empty config — a transient repo-file miss would make apps
    // look dead for minutes (repo-file misses are not cached; app-db-config was).
    return { sources: [] };
  }

  const config = parseDataSourcesFile(dataSourcesFile.content);
  mergeRegistryFiles(
    registry,
    linked?.content,
    databasesFile?.content,
    config,
  );
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
