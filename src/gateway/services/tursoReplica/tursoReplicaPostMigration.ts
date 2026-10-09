/**
 * After a registry migration is applied, refresh cloud app metadata so web
 * schema gates and git sync see the new requiredSchemaVersion.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
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
  // A teammate's copy of shared data records the publisher's app as schema
  // owner, but that app isn't on this desktop. Writing its metadata would
  // create a phantom apps/{publisherId}/ folder, which then looks like the
  // owner app is installed here (and turns the teammate into the owner).
  if (!existsSync(path.join(getPaprRoot(), "apps", schemaOwnerAppId, "metadata.json"))) {
    return { schemaOwnerAppId, appMetaUpdated: false };
  }

  const { writeCloudAppMeta } = await import("../cloudSync/cloudAppMeta.js");
  await writeCloudAppMeta(getPaprRoot(), schemaOwnerAppId);

  console.log(
    `[PaprDb] Updated __papr__/app-meta.json for ${schemaOwnerAppId} after migration ${options.migrationId}`,
  );

  return { schemaOwnerAppId, appMetaUpdated: true };
}
