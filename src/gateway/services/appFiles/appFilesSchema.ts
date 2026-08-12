/**
 * The `app_files` table — pointer rows for blobs stored in GCS.
 *
 * This is the Parse `File` pattern: the bytes live in object storage, the
 * database holds a small reference. That matters because git carries the app
 * database but must never carry a 6 GB video — repoHygiene rejects anything
 * over 25 MB, and git keeps every version forever regardless.
 *
 * `app_files` is an ordinary table, so it rides the existing Turso sync with
 * no special handling.
 */

export type UploadState = "pending" | "uploading" | "verified" | "failed";
export type FileVisibility = "inherit" | "private";

export interface AppFileRow {
  id: string;
  app_id: string;
  object_key: string;
  sha256: string;
  size_bytes: number;
  mime: string | null;
  file_name: string;
  scope: "app" | "user";
  /** Absolute path when a local copy exists; NULL once evicted. */
  local_path: string | null;
  upload_state: UploadState;
  /** 'private' means "never publish me", even if the app goes public. */
  visibility: FileVisibility;
  created_at: number;
  updated_at: number;
}

export const APP_FILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_files (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL,
  object_key    TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  mime          TEXT,
  file_name     TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'app',
  local_path    TEXT,
  upload_state  TEXT NOT NULL DEFAULT 'pending',
  visibility    TEXT NOT NULL DEFAULT 'inherit',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_files_sha ON app_files(sha256);
CREATE INDEX IF NOT EXISTS idx_app_files_state ON app_files(upload_state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_files_key ON app_files(object_key);
`;

/**
 * Where a file's bytes can be read from right now.
 *
 * Hybrid local/cloud is not extra machinery — it falls out of two columns.
 * Callers ask for a location and never branch on storage state themselves.
 */
export type FileLocation =
  | { kind: "local"; path: string }
  | { kind: "cloud"; objectKey: string }
  | { kind: "unavailable"; reason: string };

export function resolveLocation(row: AppFileRow): FileLocation {
  // Prefer local when present: it is free and instant. The cloud copy is
  // durability, not the primary read path.
  if (row.local_path) return { kind: "local", path: row.local_path };
  if (row.upload_state === "verified") {
    return { kind: "cloud", objectKey: row.object_key };
  }
  return {
    kind: "unavailable",
    reason:
      row.upload_state === "failed"
        ? "upload failed and no local copy remains"
        : `no local copy and upload is ${row.upload_state}`,
  };
}

/**
 * Can this file's local copy be deleted to reclaim disk?
 *
 * Only when the cloud copy is verified. Deleting a user's only copy of
 * something is unforgivable, so this is deliberately strict — and the caller
 * still requires an explicit user action on top.
 */
export function isEvictable(row: AppFileRow): boolean {
  return row.upload_state === "verified" && row.local_path !== null;
}

/**
 * Should this object be made CDN-public when the app is published?
 *
 * User-scoped files are private by ownership; `visibility: 'private'` is the
 * explicit opt-out for an app-scoped file. Both must stay private — this is
 * the meeting-recording guarantee.
 */
export function isPublishable(row: AppFileRow): boolean {
  return row.scope === "app" && row.visibility === "inherit";
}
