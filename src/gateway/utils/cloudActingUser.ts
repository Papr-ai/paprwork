/**
 * Acting user for memory-server /v1/cloud/* — same semantics as memory add/search.
 * Namespace API key authenticates; external_user_id selects the Parse _User.objectId
 * used for ownership (publish, git user repo, Turso user segment, vault user scope).
 */

import { getPaprUserId } from "./paprUserId.js";

export function cloudActingUserId(): string | undefined {
  const id = getPaprUserId()?.trim();
  return id || undefined;
}

/** Spread into POST/PATCH JSON bodies for cloud mutating APIs. */
export function cloudActingUserFields(): { external_user_id?: string } {
  const userId = cloudActingUserId();
  return userId ? { external_user_id: userId } : {};
}

/** Append acting-user query param for GET cloud catalog / read endpoints. */
export function appendCloudActingUserQuery(urlPath: string): string {
  const userId = cloudActingUserId();
  if (!userId) {
    return urlPath;
  }
  const separator = urlPath.includes("?") ? "&" : "?";
  return `${urlPath}${separator}external_user_id=${encodeURIComponent(userId)}`;
}

/** Merge acting user into a JSON body object when present. */
export function mergeCloudActingUserBody<T extends Record<string, unknown>>(
  body: T,
): T & { external_user_id?: string } {
  const fields = cloudActingUserFields();
  if (!fields.external_user_id) {
    return body;
  }
  return { ...body, ...fields };
}
