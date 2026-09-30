/**
 * In-memory allowlist pushed from desktop on publish (Cloud App Host).
 *
 * GET /v1/cloud/apps/publish/{appId} requires owner auth; host key alone returns
 * 401, so production must receive allowlists via /internal/app-access-updated.
 */

import type { SharePeopleAllowlist } from "./cloudAppPeopleAccess.js";
import { sharePeopleAllowlistFromFields } from "./sharePeopleAllowlistFields.js";

export interface ShareAllowlistPushRecord {
  namespaceId: string;
  slug: string;
  appId?: string;
  allowlist: SharePeopleAllowlist | undefined;
  updatedAtMs: number;
}

const byRouteKey = new Map<string, ShareAllowlistPushRecord>();
const byAppId = new Map<string, ShareAllowlistPushRecord>();

function routeKey(namespaceId: string, slug: string): string {
  return `${namespaceId.trim()}/${slug.trim()}`;
}

export function setSharePeopleAllowlistPush(input: {
  namespaceId: string;
  slug: string;
  appId?: string;
  allowlist: SharePeopleAllowlist | undefined;
}): void {
  const record: ShareAllowlistPushRecord = {
    namespaceId: input.namespaceId.trim(),
    slug: input.slug.trim(),
    appId: input.appId?.trim(),
    allowlist: input.allowlist,
    updatedAtMs: Date.now(),
  };
  byRouteKey.set(routeKey(record.namespaceId, record.slug), record);
  if (record.appId) {
    byAppId.set(record.appId, record);
  }
}

export function getSharePeopleAllowlistPush(
  namespaceId: string,
  slug: string,
  appId?: string,
): SharePeopleAllowlist | undefined {
  const fromRoute = byRouteKey.get(routeKey(namespaceId, slug));
  if (fromRoute?.allowlist) {
    return fromRoute.allowlist;
  }
  if (appId) {
    const fromApp = byAppId.get(appId);
    if (fromApp?.allowlist) {
      return fromApp.allowlist;
    }
  }
  return undefined;
}

export function clearSharePeopleAllowlistPush(namespaceId?: string, slug?: string): void {
  if (!namespaceId || !slug) {
    byRouteKey.clear();
    byAppId.clear();
    return;
  }
  const key = routeKey(namespaceId, slug);
  const record = byRouteKey.get(key);
  byRouteKey.delete(key);
  if (record?.appId) {
    byAppId.delete(record.appId);
  }
}

export function shareAllowlistFromPushBody(body: {
  allowedUserIds?: string[];
  allowedEmails?: string[];
  allowedEmailDomains?: string[];
  shareAllowlist?: {
    allowedUserIds?: string[];
    allowedEmails?: string[];
    allowedEmailDomains?: string[];
  };
}): SharePeopleAllowlist | undefined {
  return (
    sharePeopleAllowlistFromFields(body.shareAllowlist) ??
    sharePeopleAllowlistFromFields(body)
  );
}
