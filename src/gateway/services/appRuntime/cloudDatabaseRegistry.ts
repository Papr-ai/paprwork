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
import type { AppDataSourcesFile } from "../appDataSources.js";
import { fetchCachedRuntimeRepoFile } from "./cloudAppHostCache.js";
import type { AppRuntimeRouteAuth } from "./types.js";

const REGISTRY_REPO_PATH = `data/${DATABASES_REGISTRY_FILENAME}`;

export async function hydrateCloudDatabaseRegistry(
  runtimeAuth: AppRuntimeRouteAuth,
  config?: AppDataSourcesFile,
): Promise<void> {
  const registry = getDatabaseRegistryService();

  const file = await fetchCachedRuntimeRepoFile(runtimeAuth, REGISTRY_REPO_PATH);
  if (file?.content) {
    registry.mergeFromRegistryFile(file.content);
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
