/**
 * Decides what URL — if any — a cloud visitor may have for an App Files row.
 *
 * The desktop answers `/api/files/url` from `resolveFileUrl`, which may hand
 * back a local path. The cloud runtime has no filesystem, so it needs its own
 * answer: CDN for published objects, a short-lived signed URL for everything
 * else the caller is actually entitled to.
 *
 * This is the whole security surface of serving files on apps.papr.ai, so it is
 * pure and decided in one place. Acting on the decision (minting the signature)
 * is the caller's job and is deliberately trivial.
 *
 * Four rules, in order. Order matters: each one assumes the ones above it have
 * already rejected.
 */

import type { AppFileRow } from "./appFilesSchema.js";

export type CloudUrlDecision =
  /** Object is CDN-public. Serve the permanent URL, no signing round-trip. */
  | { kind: "cdn"; objectKey: string }
  /** Caller is entitled but the object is not public — mint a signed read. */
  | { kind: "signed"; appId: string; objectKey: string }
  /** Refuse. `status` is what the handler should return. */
  | { kind: "deny"; status: 403 | 404; reason: string };

export interface CloudUrlRequest {
  /** The app the request arrived on — from the session, never from the body. */
  requestedAppId: string;
  /** Whether the resolved access context can read this app at all. */
  canRead: boolean;
  /** Authenticated user, or null for a logged-out visitor on a public app. */
  userId: string | null;
  /** True once the app's objects have been flipped CDN-public by publish. */
  isPublished: boolean;
}

/**
 * Decide how (or whether) to serve one file to one caller.
 *
 * Returns `deny` with 404 rather than 403 when revealing existence would leak
 * something: a cross-app probe should not be able to tell a real id from a
 * fake one.
 */
export function resolveCloudFileUrl(
  row: AppFileRow | null,
  req: CloudUrlRequest,
): CloudUrlDecision {
  // 1. Existence and ownership. Checked together and answered identically, so
  //    that "wrong app" and "no such file" are indistinguishable from outside.
  if (!row || row.app_id !== req.requestedAppId) {
    return { kind: "deny", status: 404, reason: "File not found" };
  }

  // 2. The cloud has no local disk. An unverified row means the bytes only ever
  //    existed on someone's laptop, so there is nothing to serve — even though
  //    the same row resolves fine on the desktop.
  if (row.upload_state !== "verified") {
    return {
      kind: "deny",
      status: 404,
      reason: "File is not available in the cloud",
    };
  }

  // 3. User-scoped files belong to their uploader, not to the app's audience.
  //    A public app must never widen them, so this is checked before the
  //    published/public shortcut below rather than after it.
  //
  //    Scope comes from the key, not the column: the key is written server-side
  //    from the session, whereas the column travels through Turso sync and a
  //    desktop write path. If they ever disagree, the key is right. Mirrors
  //    `scope_of_key`.
  if (isUserScopedKey(row) || row.scope === "user") {
    if (!req.userId || req.userId !== extractOwnerId(row)) {
      return {
        kind: "deny",
        status: 403,
        reason: "This file is private to the person who uploaded it",
      };
    }
    return { kind: "signed", appId: row.app_id, objectKey: row.object_key };
  }

  // 4. `visibility: 'private'` is the meeting-recording guarantee: opted out of
  //    publishing entirely, so it is never CDN-served regardless of how public
  //    the app is. Entitled callers still get a signed URL.
  if (row.visibility === "private") {
    if (!req.canRead) {
      return { kind: "deny", status: 403, reason: "Not authorized" };
    }
    return { kind: "signed", appId: row.app_id, objectKey: row.object_key };
  }

  // Published app-scoped object: publish already flipped it CDN-public, so the
  // permanent URL works for logged-out visitors with no round-trip.
  if (req.isPublished) {
    return { kind: "cdn", objectKey: row.object_key };
  }

  // Not published yet (preview, or an unpublished app). Readers still get in,
  // via a signed URL rather than a CDN one.
  if (!req.canRead) {
    return { kind: "deny", status: 403, reason: "Not authorized" };
  }
  return { kind: "signed", appId: row.app_id, objectKey: row.object_key };
}

/**
 * Owner of a user-scoped object, read back out of its key.
 *
 * Mirrors `build_object_key` on the memory server, which derives keys from the
 * authenticated session as:
 *
 *   namespaces/{ns}/apps/{app}/users/{userId}/files/{sha256}   (scope=user)
 *   namespaces/{ns}/apps/{app}/files/{sha256}                  (scope=app)
 *
 * The key is the authoritative record of ownership — it is written server-side
 * from the session, so it is more trustworthy than any column a desktop client
 * could have set. Returns null for an unrecognised shape, which the caller
 * treats as "deny", matching `scope_of_key`'s bias toward the restrictive
 * answer when a key cannot be parsed.
 */
function extractOwnerId(row: AppFileRow): string | null {
  const match = /\/users\/([^/]+)\/files\//.exec(row.object_key);
  return match?.[1] ?? null;
}

/** True when the key says user-scoped, whatever the row's column claims. */
function isUserScopedKey(row: AppFileRow): boolean {
  return row.object_key.includes("/users/");
}

/** Public URL for a CDN-readable object. Mirrors `cdn_url()` server-side. */
export function buildCdnUrl(objectKey: string, cdnHost?: string): string {
  const host = cdnHost || process.env.APP_FILES_CDN_HOST || "files.papr.ai";
  return `https://${host}/${objectKey}`;
}
