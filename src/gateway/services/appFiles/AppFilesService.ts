/**
 * App Files orchestration: ticket → upload → verify → row.
 *
 * This is the only place that knows the full sequence. Mini-apps call
 * /api/files/*; jobs and publish call this. Neither ever sees a bucket, a
 * token, or a chunk.
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { stat } from "node:fs/promises";

import {
  commitUpload,
  createReadUrl,
  deleteObject,
  requestUploadTicket,
  type AppFileScope,
} from "./appFilesClient.js";
import {
  APP_FILES_SCHEMA,
  isEvictable,
  resolveLocation,
  type AppFileRow,
  type FileLocation,
} from "./appFilesSchema.js";
import { hashFile, uploadResumable, type UploadProgress } from "./resumableUploader.js";

/** Minimal database surface, so this service is testable without a real DB. */
export interface FilesDb {
  exec(sql: string): Promise<void> | void;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }> | { changes: number };
  all<T>(sql: string, params?: unknown[]): Promise<T[]> | T[];
}

export interface AddFileArgs {
  appId: string;
  filePath: string;
  fileName?: string;
  mime?: string;
  scope?: AppFileScope;
  /** Keep the local copy after upload. Default true — never surprise-delete. */
  keepLocal?: boolean;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

export interface AddFileResult {
  id: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  /** True when the bytes were already stored and nothing was transferred. */
  deduped: boolean;
  verified: boolean;
}

export async function ensureSchema(db: FilesDb): Promise<void> {
  await db.exec(APP_FILES_SCHEMA);
}

/**
 * Store a local file in App Files.
 *
 * Order matters here. We hash first so the key is content-addressed, which
 * makes a repeat upload free and a retry idempotent. We write the row before
 * uploading so an interrupted upload is visible as `pending` rather than
 * vanishing. And we only mark `verified` after the *server* confirms the
 * stored size — never on our own word.
 */
export async function addFile(
  db: FilesDb,
  args: AddFileArgs,
): Promise<AddFileResult> {
  const info = await stat(args.filePath);
  const sizeBytes = info.size;
  const sha256 = await hashFile(args.filePath);
  const fileName = args.fileName ?? basename(args.filePath);
  const scope = args.scope ?? "app";

  const ticket = await requestUploadTicket({
    appId: args.appId,
    sha256,
    sizeBytes,
    fileName,
    mime: args.mime,
    scope,
  });

  const now = Date.now();
  const id = randomUUID();
  await db.run(
    `INSERT INTO app_files
       (id, app_id, object_key, sha256, size_bytes, mime, file_name, scope,
        local_path, upload_state, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inherit', ?, ?)
     ON CONFLICT(object_key) DO UPDATE SET
       local_path = excluded.local_path,
       updated_at = excluded.updated_at`,
    [
      id,
      args.appId,
      ticket.object_key,
      sha256,
      sizeBytes,
      args.mime ?? null,
      fileName,
      scope,
      args.filePath,
      ticket.already_exists ? "verified" : "uploading",
      now,
      now,
    ],
  );

  if (ticket.already_exists) {
    return { id, objectKey: ticket.object_key, sha256, sizeBytes, deduped: true, verified: true };
  }

  if (!ticket.upload_url) {
    throw new Error("Server returned no upload URL for a new object");
  }

  try {
    await uploadResumable({
      sessionUrl: ticket.upload_url,
      filePath: args.filePath,
      totalBytes: sizeBytes,
      onProgress: args.onProgress,
      signal: args.signal,
    });
  } catch (err) {
    await markState(db, ticket.object_key, "failed");
    throw err;
  }

  const commit = await commitUpload(args.appId, ticket.object_key, sizeBytes);
  await markState(db, ticket.object_key, commit.verified ? "verified" : "failed");

  if (commit.verified && args.keepLocal === false) {
    await evictLocal(db, ticket.object_key);
  }

  return {
    id,
    objectKey: ticket.object_key,
    sha256,
    sizeBytes,
    deduped: false,
    verified: commit.verified,
  };
}

async function markState(
  db: FilesDb,
  objectKey: string,
  state: AppFileRow["upload_state"],
): Promise<void> {
  await db.run(
    `UPDATE app_files SET upload_state = ?, updated_at = ? WHERE object_key = ?`,
    [state, Date.now(), objectKey],
  );
}

export async function listFiles(db: FilesDb, appId: string): Promise<AppFileRow[]> {
  return db.all<AppFileRow>(
    `SELECT * FROM app_files WHERE app_id = ? ORDER BY created_at DESC`,
    [appId],
  );
}

export async function getFile(db: FilesDb, id: string): Promise<AppFileRow | null> {
  const rows = await db.all<AppFileRow>(`SELECT * FROM app_files WHERE id = ?`, [id]);
  return rows[0] ?? null;
}

/**
 * Where should a caller read this file from?
 *
 * Local when we have it, otherwise a short-lived signed URL. Callers get one
 * answer and never branch on storage state.
 */
export async function resolveFileUrl(
  db: FilesDb,
  id: string,
): Promise<{ location: FileLocation; url?: string }> {
  const row = await getFile(db, id);
  if (!row) throw Object.assign(new Error(`File ${id} not found`), { status: 404 });

  const location = resolveLocation(row);
  if (location.kind === "cloud") {
    const { url } = await createReadUrl(row.app_id, row.object_key);
    return { location, url };
  }
  return { location };
}

/**
 * Drop the local copy to reclaim disk, keeping the cloud copy.
 *
 * Refuses unless the upload is verified. The caller is expected to have got an
 * explicit user action first — this guard exists so a bug cannot delete
 * someone's only copy.
 */
export async function evictLocal(db: FilesDb, objectKey: string): Promise<boolean> {
  const rows = await db.all<AppFileRow>(
    `SELECT * FROM app_files WHERE object_key = ?`,
    [objectKey],
  );
  const row = rows[0];
  if (!row || !isEvictable(row)) return false;

  const { unlink } = await import("node:fs/promises");
  await unlink(row.local_path as string).catch(() => undefined);
  await db.run(
    `UPDATE app_files SET local_path = NULL, updated_at = ? WHERE object_key = ?`,
    [Date.now(), objectKey],
  );
  return true;
}

export async function removeFile(db: FilesDb, id: string): Promise<boolean> {
  const row = await getFile(db, id);
  if (!row) return false;
  await deleteObject(row.app_id, row.object_key);
  await db.run(`DELETE FROM app_files WHERE id = ?`, [id]);
  return true;
}
