/**
 * Desktop cloud-preview access — validate via memory server using Papr session
 * + caller external_user_id only (no desktop workspace PAPR_API_KEY).
 */

import type { CloudRouteContext } from "./cloudAppHostContext.js";
import type { AppAccessContext, AppRuntimeRouteAuth, MiniAppAccessResponse } from "./types.js";
import { MemoryServerPublishResolver } from "./CloudAppHostService.js";
import { buildMiniAppAccessResponse } from "./miniAppAccess.js";
import { getApiKey } from "../../utils/keyResolver.js";
import { getPaprCallerIdentity, getPaprUserId } from "../../utils/paprUserId.js";

const publishResolver = new MemoryServerPublishResolver();

const ACCESS_TTL_MS = 300_000;

interface TimedAccessEntry {
  value: AppAccessContext | null;
  expiresAt: number;
}

const accessCache = new Map<string, TimedAccessEntry>();
const accessResponseCache = new Map<string, { value: MiniAppAccessResponse; expiresAt: number }>();

function accessCacheKey(auth: AppRuntimeRouteAuth): string {
  return [
    auth.namespaceId,
    auth.slug,
    auth.sessionToken ?? "",
    auth.externalUserId ?? "",
    auth.shareToken ?? "",
  ].join(":");
}

export async function validateDesktopCloudPreviewAccess(
  auth: AppRuntimeRouteAuth,
): Promise<AppAccessContext | null> {
  const key = accessCacheKey(auth);
  const cached = accessCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const access = await publishResolver.validateAccess({
    namespaceId: auth.namespaceId,
    slug: auth.slug,
    sessionToken: auth.sessionToken,
    shareToken: auth.shareToken,
    externalUserId: auth.externalUserId,
  });

  // Do not negative-cache denials — session may arrive shortly after tab open.
  if (access !== null) {
    accessCache.set(key, { value: access, expiresAt: Date.now() + ACCESS_TTL_MS });
  }
  return access;
}

export async function buildDesktopCloudPreviewAccessResponse(
  ctx: CloudRouteContext,
): Promise<MiniAppAccessResponse> {
  const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
  const externalUserId = getPaprUserId();
  const responseKey = [
    ctx.namespaceId,
    ctx.slug,
    sessionToken ?? "",
    externalUserId ?? "",
    ctx.shareToken ?? "",
  ].join(":");

  const cachedResponse = accessResponseCache.get(responseKey);
  if (cachedResponse && Date.now() < cachedResponse.expiresAt) {
    return cachedResponse.value;
  }

  const caller = getPaprCallerIdentity();
  const loggedIn = Boolean(sessionToken?.trim() || externalUserId?.trim());

  const access = await validateDesktopCloudPreviewAccess({
    namespaceId: ctx.namespaceId,
    slug: ctx.slug,
    sessionToken: sessionToken ?? undefined,
    externalUserId: externalUserId ?? undefined,
    shareToken: ctx.shareToken,
  });

  const response = buildMiniAppAccessResponse(
    access,
    loggedIn,
    access?.appId,
    caller,
  );

  accessResponseCache.set(responseKey, {
    value: response,
    expiresAt: Date.now() + ACCESS_TTL_MS,
  });

  return response;
}
