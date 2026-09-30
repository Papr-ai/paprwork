/**
 * Lightweight publish intents — decouple catalog metadata from repo tarball scans.
 */

export type CloudPublishIntent = "register" | "catalog" | "sharing" | "scan";

/** Sync V3 catalog path — always on (legacy full-register fallback removed). */
export function isCloudCatalogLightSyncEnabled(): boolean {
  return true;
}

export function publishIntentTimeoutMs(intent: CloudPublishIntent): number {
  switch (intent) {
    case "scan":
      return 180_000;
    case "register":
      return 120_000;
    case "catalog":
    case "sharing":
      return 15_000;
    default:
      return 60_000;
  }
}
