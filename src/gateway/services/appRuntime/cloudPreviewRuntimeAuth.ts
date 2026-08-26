/**
 * Resolve Papr credentials for desktop cloud-preview (iframe + proxy).
 *
 * Matches apps.papr.ai: pass Parse session + caller external_user_id (and optional
 * share token). Do not attach the desktop workspace PAPR_API_KEY — Cloud App Host
 * enriches with the publisher namespace key server-side when needed.
 */

import type { CloudRouteContext } from "./cloudAppHostContext.js";
import type { AppRuntimeRouteAuth } from "./types.js";
import { enrichRuntimeAuthWithPaprApiKey } from "./resolveCloudSessionPaprApiKey.js";
import { getApiKey } from "../../utils/keyResolver.js";
import { getPaprUserId } from "../../utils/paprUserId.js";

export async function resolveCloudPreviewRuntimeAuth(
  ctx: CloudRouteContext,
): Promise<AppRuntimeRouteAuth> {
  const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
  const externalUserId = getPaprUserId();

  return {
    namespaceId: ctx.namespaceId,
    slug: ctx.slug,
    sessionToken: sessionToken ?? undefined,
    externalUserId: externalUserId ?? undefined,
    shareToken: ctx.shareToken,
  };
}

export interface CloudPreviewAuthHeaderOptions {
  /**
   * When true, resolve publisher namespace API key from session (GraphQL) and
   * attach X-API-Key — mirrors apps.papr.ai enrichRuntimeAuthWithPaprApiKey.
   * Used as a fallback when upstream still returns the share gate despite a
   * valid local session (production may not read X-Session-Token yet).
   */
  enrichFromSession?: boolean;
  /** Reuse auth from the caller to avoid duplicate keychain/IPC lookups. */
  auth?: AppRuntimeRouteAuth;
}

export async function buildCloudPreviewAuthHeaders(
  ctx: CloudRouteContext,
  options: CloudPreviewAuthHeaderOptions = {},
): Promise<Record<string, string>> {
  let auth = options.auth ?? (await resolveCloudPreviewRuntimeAuth(ctx));
  if (options.enrichFromSession) {
    auth = (await enrichRuntimeAuthWithPaprApiKey(auth)) ?? auth;
  }

  const headers: Record<string, string> = {
    "X-Papr-Namespace-Id": ctx.namespaceId,
    "X-Papr-Slug": ctx.slug,
  };
  if (auth.sessionToken) {
    headers["X-Session-Token"] = auth.sessionToken;
  }
  if (auth.externalUserId) {
    headers["X-Papr-External-User-Id"] = auth.externalUserId;
  }
  if (auth.shareToken) {
    headers["X-Papr-Share-Token"] = auth.shareToken;
  }
  if (auth.paprApiKey) {
    headers["X-API-Key"] = auth.paprApiKey;
  }
  return headers;
}

/** Share-gate HTML from apps.papr.ai when access is denied or session is missing. */
export function isCloudShareGateHtml(html: string): boolean {
  if (!html.includes("<!DOCTYPE html") && !html.includes("<html")) {
    return false;
  }
  return (
    html.includes('class="gate-status"') &&
    (html.includes("Sign in is required to access this app") ||
      html.includes("Sign in required") ||
      html.includes("No access") ||
      html.includes("Invite link required"))
  );
}
