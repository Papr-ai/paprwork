/**
 * New databases created inside a cloud agent run (any channel: iMessage, SMS,
 * web chat, scheduled agent jobs).
 *
 * The cloud gateway runs with CLOUD_SYNC_ENABLED=false, so the normal choice for
 * a new database (chooseSyncModeForNewDatabase) picked a plain local SQLite file
 * in the run's temp folder. Migrations and seed rows landed there and vanished
 * with the folder; the published app then pointed at an empty cloud database.
 *
 * In a cloud run the Turso primary is the only durable copy, so new databases
 * are cloud-direct from the start: token minted now, every migration and write
 * goes straight to the primary.
 */
import { getPaprRoot } from "../../../core/utils/paprRoot.js";
import { setCloudDirectCredentials } from "../cloudDirect/cloudDirectDb.js";
import { tursoNameForRecord, type DatabaseRecord } from "../DatabaseRegistryService.js";
import { getPaprUserId } from "../../utils/paprUserId.js";
import { mintToken } from "./catalogAppDatabases.js";
import { isCloudRunSandbox } from "./cloudSandboxTursoDirect.js";

/** True inside a cloud agent run's sandbox, whatever channel started it. */
export function isCloudAgentRunSandbox(paprHome?: string): boolean {
  return process.env.GATEWAY_MODE === "cloud_agent" && isCloudRunSandbox(paprHome ?? getPaprRoot());
}

/** Mint credentials for a cloud-direct record created in this run. Throws on failure. */
export async function connectNewCloudRunDatabase(record: DatabaseRecord): Promise<string> {
  const tursoName = tursoNameForRecord(record, getPaprUserId() ?? undefined);
  const creds = await mintToken(tursoName);
  setCloudDirectCredentials(new Map([[tursoName, creds]]));
  console.log(`[CloudRunDb] ${record.dbId} created in Papr Cloud (${tursoName})`);
  return tursoName;
}

/** Migration files live beside the database, not in the app: queue the owner app's publish. */
export async function publishSchemaOwnerAfterMigration(record: DatabaseRecord | undefined): Promise<void> {
  if (!record?.schemaOwnerAppId || process.env.GATEWAY_MODE !== "cloud_agent") return;
  const { notifyCloudSandboxAppSave } = await import("./cloudAppWriterDebouncedPush.js");
  notifyCloudSandboxAppSave(record.schemaOwnerAppId);
}
