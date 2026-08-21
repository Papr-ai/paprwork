/**
 * Desktop Paprwork → apps.papr.ai session bridge.
 *
 * Converts desktop keychain Parse session (X-Session-Token header) into the same
 * papr_session HttpOnly cookie used by normal web Auth0 login — without changing
 * /auth/login or /auth/callback for browser users.
 */

import type { Request, Response } from "express";
import {
  headerExternalUserId,
  headerSessionToken,
} from "./cloudAppHostContext.js";
import {
  buildSessionCookieForEmbeddedPreview,
  buildShareTokenCookie,
  clearLegacySessionCookies,
  isBrowsableCloudReturnToPath,
  resolveCloudAuthReturnToPath,
  sanitizeReturnToPath,
} from "./cloudAppHostCookies.js";
import { validateParseSessionToken } from "./validateParseSessionToken.js";

function headerShareToken(
  headers: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const raw = headers?.["x-papr-share-token"];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw[0]?.trim()) return raw[0].trim();
  return undefined;
}

function requestIsSecure(req: Request): boolean {
  return req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
}

function namespaceSlugFromReturnTo(
  returnTo: string,
): { namespaceId?: string; slug?: string } {
  const path = sanitizeReturnToPath(returnTo.split("?")[0]);
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) {
    return {};
  }
  return { namespaceId: segments[0], slug: segments[1] };
}

export interface DesktopBridgeCookieBundle {
  setCookieHeaders: string[];
  redirectTo: string;
}

export function buildDesktopBridgeCookieBundle(input: {
  sessionToken: string;
  externalUserId?: string;
  email?: string;
  shareToken?: string;
  namespaceId?: string;
  slug?: string;
  returnTo: string;
  secure: boolean;
}): DesktopBridgeCookieBundle {
  const setCookieHeaders: string[] = [];
  for (const clearCookie of clearLegacySessionCookies(input.secure)) {
    setCookieHeaders.push(clearCookie);
  }
  setCookieHeaders.push(
    buildSessionCookieForEmbeddedPreview(
      input.sessionToken,
      input.secure,
      input.externalUserId,
      input.email,
    ),
  );
  if (
    input.shareToken &&
    input.namespaceId &&
    input.slug
  ) {
    setCookieHeaders.push(
      buildShareTokenCookie(
        input.shareToken,
        input.namespaceId,
        input.slug,
        input.secure,
      ),
    );
  }
  return { setCookieHeaders, redirectTo: input.returnTo };
}

/**
 * GET /auth/desktop-bridge?returnTo=/ns/slug/
 * Requires X-Session-Token (desktop/gateway only — browsers cannot set this on navigation).
 */
export async function handleCloudAppHostDesktopBridge(
  req: Request,
  res: Response,
): Promise<void> {
  const sessionToken = headerSessionToken(req.headers);
  if (!sessionToken?.trim()) {
    res.status(401).json({
      error: "authentication_required",
      message: "Desktop bridge requires X-Session-Token header.",
    });
    return;
  }

  const returnTo = resolveCloudAuthReturnToPath(
    typeof req.query.returnTo === "string" ? req.query.returnTo : undefined,
  );
  if (!isBrowsableCloudReturnToPath(returnTo.split("?")[0])) {
    res.status(400).json({ error: "invalid_return_to" });
    return;
  }

  const user = await validateParseSessionToken(sessionToken);
  if (!user) {
    res.status(401).json({
      error: "invalid_session",
      message: "Parse session token is invalid or expired.",
    });
    return;
  }

  const secure = requestIsSecure(req);
  const externalUserId = headerExternalUserId(req.headers) ?? user.objectId;
  const shareToken = headerShareToken(req.headers);
  const { namespaceId, slug } = namespaceSlugFromReturnTo(returnTo);

  const bundle = buildDesktopBridgeCookieBundle({
    sessionToken: sessionToken.trim(),
    externalUserId,
    email: user.email,
    shareToken,
    namespaceId,
    slug,
    returnTo,
    secure,
  });

  for (const cookie of bundle.setCookieHeaders) {
    res.append("Set-Cookie", cookie);
  }
  res.redirect(302, bundle.redirectTo);
}
