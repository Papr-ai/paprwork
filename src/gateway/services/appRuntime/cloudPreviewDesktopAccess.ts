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

export async function validateDesktopCloudPreviewAccess(
  auth: AppRuntimeRouteAuth,
): Promise<AppAccessContext | null> {
  return publishResolver.validateAccess({
    namespaceId: auth.namespaceId,
    slug: auth.slug,
    sessionToken: auth.sessionToken,
    shareToken: auth.shareToken,
    externalUserId: auth.externalUserId,
  });
}

export async function buildDesktopCloudPreviewAccessResponse(
  ctx: CloudRouteContext,
): Promise<MiniAppAccessResponse> {
  const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
  const externalUserId = getPaprUserId();
  const caller = getPaprCallerIdentity();
  const loggedIn = Boolean(sessionToken?.trim() || externalUserId?.trim());

  const access = await validateDesktopCloudPreviewAccess({
    namespaceId: ctx.namespaceId,
    slug: ctx.slug,
    sessionToken: sessionToken ?? undefined,
    externalUserId: externalUserId ?? undefined,
    shareToken: ctx.shareToken,
  });

  return buildMiniAppAccessResponse(
    access,
    loggedIn,
    access?.appId,
    caller,
  );
}
