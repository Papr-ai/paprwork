/**
 * Client for the memory server's App Files API (/v1/files/*).
 *
 * The gateway never holds bucket credentials. It asks the memory server for a
 * ticket, gets back a URL scoped to exactly one object, and the bytes go
 * straight from here to GCS. See "App Files — Architecture".
 *
 * Every call reuses cloudApiFetch so authentication stays on a single path —
 * the same one repos and vault keys already use.
 */

import { cloudApiFetch } from "../../utils/cloudApiClient.js";

/** Shared with everyone who can reach the app, or private to one member. */
export type AppFileScope = "app" | "user";

export interface UploadTicket {
  object_key: string;
  upload_url: string | null;
  /** True when this content already exists — skip the transfer entirely. */
  already_exists: boolean;
  scope: AppFileScope;
  max_bytes: number;
}

export interface CommitResult {
  verified: boolean;
  object_key: string;
  size_bytes?: number;
  md5?: string;
  reason?: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await cloudApiFetch(path, { method: "POST", body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`App Files ${path} failed (${res.status}): ${text.slice(0, 300)}`),
      { status: res.status },
    );
  }
  return (await res.json()) as T;
}

export interface RequestTicketArgs {
  appId: string;
  sha256: string;
  sizeBytes: number;
  fileName?: string;
  mime?: string;
  scope?: AppFileScope;
}

/**
 * Ask for permission to upload one object.
 *
 * Note we deliberately do NOT send a namespace: the server derives the object
 * key from the authenticated session. Anything we sent would be ignored, and
 * sending it would imply the client has a say.
 */
export async function requestUploadTicket(
  args: RequestTicketArgs,
): Promise<UploadTicket> {
  return post<UploadTicket>("/v1/files/tickets", {
    app_id: args.appId,
    sha256: args.sha256,
    size_bytes: args.sizeBytes,
    file_name: args.fileName,
    mime: args.mime,
    scope: args.scope ?? "app",
  });
}

/** Have the server confirm the uploaded bytes match what we promised. */
export async function commitUpload(
  appId: string,
  objectKey: string,
  sizeBytes: number,
): Promise<CommitResult> {
  return post<CommitResult>("/v1/files/commit", {
    app_id: appId,
    object_key: objectKey,
    size_bytes: sizeBytes,
  });
}

/** Short-lived signed read URL for a private object. */
export async function createReadUrl(
  appId: string,
  objectKey: string,
): Promise<{ url: string; expiresInSeconds: number }> {
  const res = await post<{ url: string; expires_in_seconds: number }>(
    "/v1/files/read-url",
    { app_id: appId, object_key: objectKey },
  );
  return { url: res.url, expiresInSeconds: res.expires_in_seconds };
}

/**
 * Flip CDN visibility. Called by publish/unpublish, never directly by a user.
 * The server returns 403 for user-scoped objects, so publishing a public app
 * cannot expose someone's private file.
 */
export async function setVisibility(
  appId: string,
  objectKey: string,
  isPublic: boolean,
): Promise<{ object_key: string; public: boolean; cdn_url: string | null }> {
  return post("/v1/files/visibility", {
    app_id: appId,
    object_key: objectKey,
    public: isPublic,
  });
}

export async function deleteObject(
  appId: string,
  objectKey: string,
): Promise<{ deleted: boolean }> {
  return post("/v1/files/delete", { app_id: appId, object_key: objectKey });
}

export async function appUsage(
  appId: string,
): Promise<{ used_bytes: number; quota_bytes: number }> {
  return post("/v1/files/usage", { app_id: appId });
}
