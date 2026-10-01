/**
 * Fork/track lineage for cloud-installed mini-apps.
 */

export type CloudAppInstallMode = "fork" | "track";

/** Persisted DB attach mode after install (lineage v1.2+). */
export type DatabasePolicy = "shared" | "forked";

export interface CloudAppLineageSource {
  orgId: string;
  namespaceId: string;
  userId: string;
  appId: string;
  slug: string;
}

export interface CloudAppLineageFile {
  schemaVersion: "1.0.0" | "1.1.0" | "1.2.0";
  lineageId: string;
  mode: CloudAppInstallMode;
  source: CloudAppLineageSource;
  /** fork → forked (installer DB); track + shared → shared (publisher primary). */
  databasePolicy?: DatabasePolicy;
  installedAt: string;
  /** ISO timestamp of last successful upstream sync (track mode). */
  lastSyncedAt?: string;
  /** Live revision from apps.papr.ai at last sync (track mode). */
  upstreamRevision?: string;
  /**
   * Auto-pull when the publisher ships a new revision. v5: opt-in only
   * (absent = off). New installs write false; code changes only when the user
   * picks Get updates. Background checks still light "Publisher has updates".
   */
  trackAutoPull?: boolean;
  /**
   * v5: when the user detached this copy. An event, not a second state field:
   * mode/databasePolicy already say "own app"; this only tells a detached copy
   * apart from an older fork install so proposals can be refused for it.
   */
  detachedAt?: string;
  /** relative path → sha256 of last synced upstream content */
  syncSnapshot?: Record<string, string>;
  /**
   * Publisher git commit this copy is based on: set at install, advanced only
   * by a pull that applied cleanly. Proposals branch from it and pulls merge
   * against it, so a stale local file is never mistaken for an edit.
   * Absent on older installs (callers infer from installedAt).
   */
  baseCommit?: string;
  /**
   * Who the publisher shared the source with when this copy was installed.
   * Drives the collaborator mark by the title (team / specific people /
   * Community). Absent on older installs: callers fall back to databasePolicy.
   */
  sourceAudience?: "team" | "people" | "community";
  /**
   * relative path → sha256 of local content at the last proposal sent.
   * Edits matching it are "proposed" (waiting on the owner), not "unproposed".
   */
  proposedSnapshot?: Record<string, string>;
  /**
   * title / description / icon / tags as this copy had them at install or
   * the last clean sync (after the install title suffix). Fields that differ
   * from it are the collaborator's deliberate metadata edits, proposed
   * field-by-field; absent on older installs (metadata edits not proposed).
   */
  metadataBaseline?: CloudAppMetadataFields;
  /**
   * The publisher's title / description / icon / tags at the last sync.
   * A track pull only replaces a field the publisher actually changed, so the
   * copy's install suffix ("Title_2") and pending edits survive updates.
   */
  metadataUpstreamBaseline?: CloudAppMetadataFields;
}

export interface CloudAppMetadataFields {
  title?: string;
  description?: string;
  icon?: string;
  tags?: string[];
}
