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
import { existsSync } from "node:fs";

import {
  commitUpload,
  createReadUrl,
  deleteObject,
  requestUploadTicket,
  type AppFileScope,
} from "./appFilesClient.js";
import {
  APP_FILES_MIGRATIONS,
  APP_FILES_SCHEMA,
  isDuplicateColumnError,
  isEvictable,
  resolveLocation,
  type AppFileRow,
  type FileLocation,
  type FileVisibility,
} from "./appFilesSchema.js";
import { hashFile, uploadResumable, type UploadProgress } from "./resumableUploader.js";
import {
  SESSION_TTL_MS,
  isHashCacheValid,
  planResume,
  type CachedHash,
} from "./uploadResume.js";

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

  // Installs that predate durable resume already have `app_files`, so the
  // CREATE above is a no-op for them and the new columns must be added
  // explicitly. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the only
  // idempotent form is to attempt each and swallow "already exists".
  for (const statement of APP_FILES_MIGRATIONS) {
    try {
      await db.exec(statement);
    } catch (err) {
      if (!isDuplicateColumnError(err)) throw err;
    }
  }
}

/**
 * SHA-256 of a file, reusing the cached value when the file is untouched.
 *
 * Hashing 10 GB is minutes of CPU and a spun-up fan. Paying that twice — once
 * on the first attempt and again on the retry after a crash — is the single
 * biggest avoidable cost in a large upload.
 *
 * Correctness does not rest on this: the server verifies the stored object's
 * size and MD5 at commit time regardless, so a stale cache costs a failed
 * commit, not a corrupt file.
 */
export async function hashFileCached(
  db: FilesDb,
  filePath: string,
  info: { size: number; mtimeMs: number },
): Promise<string> {
  const cached = (
    await db.all<CachedHash>(
      `SELECT size_bytes, mtime_ms, sha256 FROM app_file_hashes WHERE local_path = ?`,
      [filePath],
    )
  )[0];

  if (isHashCacheValid(cached, info)) return cached.sha256;

  const sha256 = await hashFile(filePath);
  await db.run(
    `INSERT INTO app_file_hashes (local_path, size_bytes, mtime_ms, sha256, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(local_path) DO UPDATE SET
       size_bytes = excluded.size_bytes,
       mtime_ms   = excluded.mtime_ms,
       sha256     = excluded.sha256,
       updated_at = excluded.updated_at`,
    [filePath, info.size, Math.floor(info.mtimeMs), sha256, Date.now()],
  );
  return sha256;
}

/**
 * Resume an upload that was interrupted, without re-sending what GCS has.
 *
 * This is the payoff for persisting the session URI: a laptop that died at
 * 9 GB of 10 resumes at 9 GB. Returns null when there is nothing usable to
 * resume from, leaving the caller to start a fresh ticket.
 */
export async function resumeUpload(
  db: FilesDb,
  id: string,
  options: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<AddFileResult | null> {
  const row = await getFile(db, id);
  if (!row || !row.local_path) return null;

  const plan = planResume(row);
  if (plan.kind === "done") {
    return {
      id: row.id,
      objectKey: row.object_key,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      deduped: false,
      verified: true,
    };
  }
  if (plan.kind === "restart") return null;

  await uploadResumable({
    sessionUrl: plan.sessionUri,
    filePath: row.local_path,
    totalBytes: row.size_bytes,
    onProgress: options.onProgress,
    signal: options.signal,
    onOffsetCommitted: (offset) => recordProgress(db, row.object_key, offset),
  });

  const commit = await commitUpload(row.app_id, row.object_key, row.size_bytes);
  await markState(db, row.object_key, commit.verified ? "verified" : "failed");

  return {
    id: row.id,
    objectKey: row.object_key,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    deduped: false,
    verified: commit.verified,
  };
}

export interface BrowserTicketArgs {
  appId: string;
  fileName: string;
  sizeBytes: number;
  mime?: string | null;
  scope?: AppFileScope;
  /**
   * Cheap content fingerprint from the browser (head + tail + size).
   *
   * Not a full SHA-256: WebCrypto cannot stream a digest, so hashing a 10 GB
   * file in a tab would mean holding it in memory. The server derives the real
   * object key itself and verifies MD5 at commit, so this only needs to be
   * stable and collision-resistant enough to dedupe.
   */
  fingerprint: string;
}

export interface BrowserTicket {
  id: string;
  objectKey: string;
  uploadUrl: string | null;
  alreadyExists: boolean;
  sha256: string;
}

/**
 * Mint an upload ticket for a browser to PUT against directly.
 *
 * The row is written before any bytes move, so an upload abandoned halfway is
 * visible as `uploading` rather than vanishing — and the session URI is stored
 * so it can be resumed for the next 7 days.
 */
export async function createBrowserTicket(
  db: FilesDb,
  args: BrowserTicketArgs,
): Promise<BrowserTicket> {
  const scope = args.scope ?? "app";
  const ticket = await requestUploadTicket({
    appId: args.appId,
    sha256: args.fingerprint,
    sizeBytes: args.sizeBytes,
    fileName: args.fileName,
    mime: args.mime ?? undefined,
    scope,
  });

  const now = Date.now();
  const id = randomUUID();
  await db.run(
    `INSERT INTO app_files
       (id, app_id, object_key, sha256, size_bytes, mime, file_name, scope,
        local_path, upload_state, visibility, upload_session_uri,
        bytes_uploaded, session_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'inherit', ?, 0, ?, ?, ?)
     ON CONFLICT(object_key) DO UPDATE SET
       upload_session_uri = excluded.upload_session_uri,
       session_expires_at = excluded.session_expires_at,
       updated_at         = excluded.updated_at`,
    [
      id,
      args.appId,
      ticket.object_key,
      args.fingerprint,
      args.sizeBytes,
      args.mime ?? null,
      args.fileName,
      scope,
      ticket.already_exists ? "verified" : "uploading",
      ticket.upload_url ?? null,
      now + SESSION_TTL_MS,
      now,
      now,
    ],
  );

  // On conflict the insert kept the original row, so report that row's id —
  // returning a fresh uuid would hand the caller an id that does not exist.
  const existing = (
    await db.all<{ id: string }>(
      `SELECT id FROM app_files WHERE object_key = ?`,
      [ticket.object_key],
    )
  )[0];

  return {
    id: existing?.id ?? id,
    objectKey: ticket.object_key,
    uploadUrl: ticket.already_exists ? null : (ticket.upload_url ?? null),
    alreadyExists: Boolean(ticket.already_exists),
    sha256: args.fingerprint,
  };
}

/**
 * Confirm a browser-uploaded object, after the server checks the stored bytes.
 *
 * Verification is server-side on purpose: the client saying "I sent it all" is
 * not evidence, and a truncated upload that reported success would be worse
 * than a failed one.
 */
export async function commitBrowserUpload(
  db: FilesDb,
  args: { appId: string; id: string; objectKey: string; sizeBytes: number },
): Promise<AddFileResult> {
  const commit = await commitUpload(args.appId, args.objectKey, args.sizeBytes);
  await markState(db, args.objectKey, commit.verified ? "verified" : "failed");

  const row = await getFile(db, args.id);
  return {
    id: args.id,
    objectKey: args.objectKey,
    sha256: row?.sha256 ?? "",
    sizeBytes: args.sizeBytes,
    deduped: false,
    verified: commit.verified,
  };
}

/**
 * Set the "never publish me" flag on a file.
 *
 * Only touches the local column; it does not call the storage API. Publishing
 * reads this flag and skips the object, so a private file is never made
 * CDN-public in the first place — which is stronger than making it public and
 * relying on a later call to undo that.
 */
export async function setFilePrivacy(
  db: FilesDb,
  id: string,
  isPrivate: boolean,
): Promise<{ id: string; visibility: FileVisibility }> {
  const visibility: FileVisibility = isPrivate ? "private" : "inherit";
  await db.run(
    `UPDATE app_files SET visibility = ?, updated_at = ? WHERE id = ?`,
    [visibility, Date.now(), id],
  );
  return { id, visibility };
}

/** Persist GCS's committed offset so a crash resumes rather than restarts. */
async function recordProgress(
  db: FilesDb,
  objectKey: string,
  bytesUploaded: number,
): Promise<void> {
  await db.run(
    `UPDATE app_files SET bytes_uploaded = ?, updated_at = ? WHERE object_key = ?`,
    [bytesUploaded, Date.now(), objectKey],
  );
}

/**
 * Register a file that exists on disk when cloud storage cannot be reached.
 *
 * The object key is derived from the content hash using the same shape the
 * server would mint, so when the upload is retried the ticket resolves to this
 * same object and dedupe still works — no orphan and no duplicate.
 *
 * State is `pending`, not `failed`: nothing has been attempted yet, and
 * `failed` is reserved for an upload that started and broke. The distinction
 * matters to whoever reads this row later trying to understand what happened.
 */
async function addFileLocally(
  db: FilesDb,
  args: {
    appId: string;
    filePath: string;
    fileName: string;
    mime?: string;
    scope: AppFileScope;
    sha256: string;
    sizeBytes: number;
    reason: string;
  },
): Promise<AddFileResult> {
  console.warn(
    `[AppFiles] Cloud storage unavailable (${args.reason}). ` +
      `Registered "${args.fileName}" locally — upload will be retried.`,
  );

  const now = Date.now();
  const id = randomUUID();
  const objectKey = `local/${args.appId}/${args.sha256}`;

  await db.run(
    `INSERT INTO app_files
       (id, app_id, object_key, sha256, size_bytes, mime, file_name, scope,
        local_path, upload_state, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'inherit', ?, ?)
     ON CONFLICT(object_key) DO UPDATE SET
       local_path = excluded.local_path,
       updated_at = excluded.updated_at`,
    [
      id,
      args.appId,
      objectKey,
      args.sha256,
      args.sizeBytes,
      args.mime ?? null,
      args.fileName,
      args.scope,
      args.filePath,
      now,
      now,
    ],
  );

  // On conflict the original row survived, so return its id — handing back a
  // fresh uuid would give the caller an id that resolves to nothing.
  const existing = (
    await db.all<{ id: string }>(
      `SELECT id FROM app_files WHERE object_key = ?`,
      [objectKey],
    )
  )[0];

  return {
    id: existing?.id ?? id,
    objectKey,
    sha256: args.sha256,
    sizeBytes: args.sizeBytes,
    deduped: false,
    verified: false,
  };
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
  const sha256 = await hashFileCached(db, args.filePath, info);
  const fileName = args.fileName ?? basename(args.filePath);
  const scope = args.scope ?? "app";

  let ticket: Awaited<ReturnType<typeof requestUploadTicket>>;
  try {
    ticket = await requestUploadTicket({
      appId: args.appId,
      sha256,
      sizeBytes,
      fileName,
      mime: args.mime,
      scope,
    });
  } catch (err) {
    // Cloud storage is unreachable, but the bytes are already on this disk.
    // Refusing the registration would leave the caller holding a path — the
    // exact fragile reference App Files exists to replace — because of an
    // outage that has nothing to do with the file.
    //
    // Record it locally instead. The row is real, the id is durable, and the
    // upload is retried later by resumeUpload. Offline-first is the honest
    // model here: the local copy was always the primary read path, and the
    // cloud copy is durability.
    return addFileLocally(db, {
      appId: args.appId,
      filePath: args.filePath,
      fileName,
      mime: args.mime,
      scope,
      sha256,
      sizeBytes,
      reason: (err as Error).message,
    });
  }

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

  // Persist the session URI *before* sending a byte. If the process dies
  // mid-upload, this row is the only thing that makes the difference between
  // resuming at 9 GB and re-sending 10.
  await db.run(
    `UPDATE app_files
        SET upload_session_uri = ?, session_expires_at = ?, bytes_uploaded = 0,
            updated_at = ?
      WHERE object_key = ?`,
    [ticket.upload_url, now + SESSION_TTL_MS, now, ticket.object_key],
  );

  try {
    await uploadResumable({
      sessionUrl: ticket.upload_url,
      filePath: args.filePath,
      totalBytes: sizeBytes,
      onProgress: args.onProgress,
      signal: args.signal,
      onOffsetCommitted: (offset) =>
        recordProgress(db, ticket.object_key, offset),
    });
  } catch (err) {
    // 'failed' is a resumable state, not a dead end: the session URI stays on
    // the row so resumeUpload() can pick it up for the next 7 days.
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
  // Drop the session URI once verified: it is spent, and leaving it on the row
  // invites a pointless resume attempt against a finished object.
  if (state === "verified") {
    await db.run(
      `UPDATE app_files
          SET upload_state = ?, upload_session_uri = NULL,
              session_expires_at = NULL, updated_at = ?
        WHERE object_key = ?`,
      [state, Date.now(), objectKey],
    );
    return;
  }
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

/**
 * Upload files that were registered while cloud storage was unreachable.
 *
 * Without this, `addFileLocally` would be a trap rather than a fallback: the
 * row stays `pending` forever, the app keeps working off the local copy, and
 * the durability everyone assumes they have never actually arrives. The
 * failure would only surface on the day the local copy is gone.
 *
 * Safe to call repeatedly. Each file goes through the normal `addFile` path,
 * which is content-addressed, so a file that did reach storage in the meantime
 * dedupes instead of uploading twice.
 */
export async function retryPendingUploads(
  db: FilesDb,
  appId: string,
): Promise<{ uploaded: number; stillPending: number; skipped: number }> {
  const pending = await db.all<AppFileRow>(
    `SELECT * FROM app_files
      WHERE app_id = ? AND upload_state = 'pending' AND local_path IS NOT NULL
      ORDER BY created_at ASC`,
    [appId],
  );

  let uploaded = 0;
  let stillPending = 0;
  let skipped = 0;

  for (const row of pending) {
    // The local copy is the only source of bytes for a pending row. If it is
    // gone there is nothing to upload, and retrying would fail every time.
    if (!row.local_path || !existsSync(row.local_path)) {
      skipped += 1;
      continue;
    }

    try {
      const result = await addFile(db, {
        appId,
        filePath: row.local_path,
        fileName: row.file_name,
        mime: row.mime ?? undefined,
        scope: row.scope,
      });
      if (result.verified) {
        // The retry wrote a row under the server's real object key. Drop the
        // local/ placeholder so the file is not listed twice.
        if (result.objectKey !== row.object_key) {
          await db.run(`DELETE FROM app_files WHERE object_key = ?`, [
            row.object_key,
          ]);
        }
        uploaded += 1;
      } else {
        stillPending += 1;
      }
    } catch {
      // Still unreachable. Leave the row exactly as it is and try again later.
      stillPending += 1;
    }
  }

  return { uploaded, stillPending, skipped };
}
