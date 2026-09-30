/**
 * After a registry migration is applied, refresh cloud app metadata so web
 * schema gates and git sync see the new requiredSchemaVersion.
 */

import type { AppDataSource } from "../appDataSources.js";
import { getDatabaseRegistryService } from "../DatabaseRegistryService.js";
import { getPaprRoot } from "../../../core/utils/paprRoot.js";

export async function afterRegistryMigrationApplied(options: {
  dbId: string;
  migrationId: string;
  source: AppDataSource;
}): Promise<{ schemaOwnerAppId: string | null; appMetaUpdated: boolean }> {
  const registry = getDatabaseRegistryService();
  const record = registry.getById(options.dbId);
  const schemaOwnerAppId = record?.schemaOwnerAppId?.trim() ?? null;
  if (!schemaOwnerAppId) {
    return { schemaOwnerAppId: null, appMetaUpdated: false };
  }

  const { writeCloudAppMeta } = await import("../cloudSync/cloudAppMeta.js");
  await writeCloudAppMeta(getPaprRoot(), schemaOwnerAppId);

  console.log(
    `[PaprDb] Updated __papr__/app-meta.json for ${schemaOwnerAppId} after migration ${options.migrationId}`,
  );

  return { schemaOwnerAppId, appMetaUpdated: true };
}
