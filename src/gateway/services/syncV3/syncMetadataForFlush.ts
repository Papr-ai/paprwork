/**
 * Push namespace databases.json + per-app db config to Mongo before web publish.
 * Git/repo files are source of truth; Mongo must match after every flush.
 */

import * as fs from "fs";
import * as path from "path";
import type { DatabasesRegistryFile } from "../DatabaseRegistryService.js";
import { DATABASES_REGISTRY_FILENAME } from "../DatabaseRegistryService.js";
import { uploadAppDbConfigToCloud } from "./appDbConfigUpload.js";
import { uploadDatabasesRegistryToCloud } from "./MetadataRegistryClient.js";

function readNamespaceDatabasesRegistry(
  paprDir: string,
): DatabasesRegistryFile | null {
  const registryPath = path.join(paprDir, "data", DATABASES_REGISTRY_FILENAME);
  if (!fs.existsSync(registryPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(registryPath, "utf8"),
    ) as DatabasesRegistryFile;
    if (parsed?.databases && typeof parsed.databases === "object") {
      return parsed;
    }
  } catch {
    /* invalid on disk */
  }
  return null;
}

/**
 * Upload app db-config + namespace databases registry to Memory Mongo.
 * Throws on failure so Upload/publish does not succeed with stale runtime metadata.
 */
export async function syncMetadataToCloudForFlush(
  paprDir: string,
  appId: string,
  commitSha?: string,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const errors: string[] = [];

  const appUploaded = await uploadAppDbConfigToCloud(paprDir, appId, commitSha);
  if (appUploaded === false) {
    const configPath = path.join(paprDir, "apps", appId, "data-sources.json");
    if (fs.existsSync(configPath)) {
      errors.push(`app db-config upload failed for ${appId}`);
    }
  }

  const registry = readNamespaceDatabasesRegistry(paprDir);
  if (registry) {
    const registryUploaded = await uploadDatabasesRegistryToCloud(
      registry,
      updatedAt,
    );
    if (!registryUploaded) {
      errors.push("namespace databases registry upload failed");
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Metadata sync to cloud failed — ${errors.join("; ")}. ` +
        "Web runtime may reject db-token until metadata outbox retries succeed.",
    );
  }
}
