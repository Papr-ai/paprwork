/**
 * Whether desktop cloud sync (Turso / workspace log ship) is enabled.
 * Electron sets CLOUD_SYNC_ENABLED from Settings → preferences.cloudSyncEnabled.
 */

export function isCloudSyncEnabled(): boolean {
  return process.env.CLOUD_SYNC_ENABLED !== "false";
}
