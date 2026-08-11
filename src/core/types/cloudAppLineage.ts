/**
 * Fork/track lineage for cloud-installed mini-apps.
 */

export type CloudAppInstallMode = "fork" | "track";

export interface CloudAppLineageSource {
  orgId: string;
  namespaceId: string;
  userId: string;
  appId: string;
  slug: string;
}

export interface CloudAppLineageFile {
  schemaVersion: "1.0.0" | "1.1.0";
  lineageId: string;
  mode: CloudAppInstallMode;
  source: CloudAppLineageSource;
  installedAt: string;
  /** ISO timestamp of last successful upstream sync (track mode). */
  lastSyncedAt?: string;
  /** Live revision from apps.papr.ai at last sync (track mode). */
  upstreamRevision?: string;
  /** Auto-pull when publisher ships a new revision (default true). */
  trackAutoPull?: boolean;
  /** relative path → sha256 of last synced upstream content */
  syncSnapshot?: Record<string, string>;
}
