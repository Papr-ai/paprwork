/**
 * Signed HttpOnly cookies for Cloud App Host auth (session + PKCE pending + share links).
 */

import * as crypto from "crypto";
import {
  ensurePublishedAppRootTrailingSlash,
  publishedAppBaseHref,
} from "../../../core/utils/cloudAppPath.js";

const NON_BROWSABLE_RETURN_TO_PREFIXES = ["/api/", "/auth/", "/__papr__/"] as const;

export const PAPR_SESSION_COOKIE = "papr_session";
export const PAPR_AUTH_PENDING_COOKIE = "papr_auth_pending";
export const PAPR_SHARE_TOKEN_COOKIE = "papr_share";

const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7;
const PENDING_MAX_AGE_SEC = 60 * 10;
const SHARE_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export function getCookieSigningSecret(): string {
  const secret = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();
  if (!secret) {
    throw new Error("PAPR_CLOUD_APP_HOST_KEY is required for cookie signing");
  }
  return secret;
}

export interface SessionCookieDiagnostics {
  sessionCookiePresent: boolean;
  sessionCookieValid: boolean;
  authPendingPresent: boolean;
}

/** Safe diagnostics for /auth/status — never exposes token values. */
export function getSessionCookieDiagnostics(
  cookieHeader: string | undefined,
): SessionCookieDiagnostics {
  const sessionCookiePresent = Boolean(
    cookieHeader?.split(";").some((part) => part.trim().startsWith(`${PAPR_SESSION_COOKIE}=`)),
  );
  const authPendingPresent = Boolean(
    cookieHeader?.split(";").some((part) => part.trim().startsWith(`${PAPR_AUTH_PENDING_COOKIE}=`)),
  );
  return {
    sessionCookiePresent,
    sessionCookieValid: Boolean(readSessionTokenFromCookie(cookieHeader)),
    authPendingPresent,
  };
}

function signPayload(payload: string, secret: string): string {
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySignedPayload(signed: string, secret: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = signed.slice(0, dot);
  const signature = signed.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  return payload;
}

function encodeSignedJson(value: Record<string, unknown>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return signPayload(payload, secret);
}

function decodeSignedJson<T extends Record<string, unknown>>(
  signed: string,
  secret: string,
): T | null {
  const payload = verifySignedPayload(signed, secret);
  if (!payload) return null;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function cookieSuffix(maxAgeSec: number, secure: boolean, path = "/"): string {
  return `Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

function cookieSuffixEmbedded(maxAgeSec: number, secure: boolean, path = "/"): string {
  // SameSite=None so cookies work in Paprwork desktop iframes (cross-site parent).
  const sameSite = secure ? "None" : "Lax";
  return `Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function buildSessionCookie(
  sessionToken: string,
  secure: boolean,
  externalUserId?: string,
  email?: string,
): string {
  const secret = getCookieSigningSecret();
  const payload: Record<string, unknown> = {
    sessionToken,
    exp: Date.now() + SESSION_MAX_AGE_SEC * 1000,
  };
  const trimmedUserId = externalUserId?.trim();
  if (trimmedUserId) {
    payload.externalUserId = trimmedUserId;
  }
  const trimmedEmail = email?.trim();
  if (trimmedEmail) {
    payload.email = trimmedEmail;
  }
  const value = encodeSignedJson(payload, secret);
  // Path=/ is required — Path=/auth only sends the cookie to /auth/* (breaks app routes).
  return `${PAPR_SESSION_COOKIE}=${encodeURIComponent(value)}; ${cookieSuffix(SESSION_MAX_AGE_SEC, secure, "/")}`;
}

/** Session cookie for desktop-bridge / embedded iframe preview (cross-site parent). */
export function buildSessionCookieForEmbeddedPreview(
  sessionToken: string,
  secure: boolean,
  externalUserId?: string,
  email?: string,
): string {
  const secret = getCookieSigningSecret();
  const payload: Record<string, unknown> = {
    sessionToken,
    exp: Date.now() + SESSION_MAX_AGE_SEC * 1000,
  };
  const trimmedUserId = externalUserId?.trim();
  if (trimmedUserId) {
    payload.externalUserId = trimmedUserId;
  }
  const trimmedEmail = email?.trim();
  if (trimmedEmail) {
    payload.email = trimmedEmail;
  }
  const value = encodeSignedJson(payload, secret);
  return `${PAPR_SESSION_COOKIE}=${encodeURIComponent(value)}; ${cookieSuffixEmbedded(SESSION_MAX_AGE_SEC, secure, "/")}`;
}

/** Clears session cookies at both / and legacy /auth paths (production had a bad scope). */
export function clearLegacySessionCookies(secure: boolean): string[] {
  return [
    `${PAPR_SESSION_COOKIE}=; ${cookieSuffix(0, secure, "/")}`,
    `${PAPR_SESSION_COOKIE}=; ${cookieSuffix(0, secure, "/auth")}`,
  ];
}

export interface CloudAppSessionCookie {
  sessionToken: string;
  externalUserId?: string;
  email?: string;
}

export function readCloudAppSessionFromCookie(
  cookieHeader: string | undefined,
): CloudAppSessionCookie | undefined {
  if (!cookieHeader) return undefined;
  const secret = getCookieSigningSecret();
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${PAPR_SESSION_COOKIE}=`)) continue;
    const raw = decodeURIComponent(trimmed.slice(PAPR_SESSION_COOKIE.length + 1));
    const parsed = decodeSignedJson<{
      sessionToken?: string;
      externalUserId?: string;
      email?: string;
      exp?: number;
    }>(raw, secret);
    if (!parsed?.sessionToken || typeof parsed.exp !== "number") return undefined;
    if (parsed.exp < Date.now()) return undefined;
    const externalUserId = parsed.externalUserId?.trim();
    const email = parsed.email?.trim();
    return {
      sessionToken: parsed.sessionToken,
      ...(externalUserId ? { externalUserId } : {}),
      ...(email ? { email } : {}),
    };
  }
  return undefined;
}

export function readSessionTokenFromCookie(
  cookieHeader: string | undefined,
): string | undefined {
  return readCloudAppSessionFromCookie(cookieHeader)?.sessionToken;
}

export function clearSessionCookie(secure: boolean): string {
  return clearLegacySessionCookies(secure)[0];
}

export interface AuthPendingPayload extends Record<string, unknown> {
  state: string;
  codeVerifier: string;
  returnTo: string;
  exp: number;
}

export function buildAuthPendingCookie(
  payload: Omit<AuthPendingPayload, "exp">,
  secure: boolean,
): string {
  const secret = getCookieSigningSecret();
  const value = encodeSignedJson(
    { ...payload, exp: Date.now() + PENDING_MAX_AGE_SEC * 1000 },
    secret,
  );
  // Path=/ so the pending cookie survives Auth0 redirects and any proxy path quirks.
  return `${PAPR_AUTH_PENDING_COOKIE}=${encodeURIComponent(value)}; ${cookieSuffix(PENDING_MAX_AGE_SEC, secure, "/")}`;
}

export function readAuthPendingCookie(
  cookieHeader: string | undefined,
): AuthPendingPayload | null {
  if (!cookieHeader) return null;
  const secret = getCookieSigningSecret();
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${PAPR_AUTH_PENDING_COOKIE}=`)) continue;
    const raw = decodeURIComponent(trimmed.slice(PAPR_AUTH_PENDING_COOKIE.length + 1));
    const parsed = decodeSignedJson<AuthPendingPayload>(raw, secret);
    if (!parsed?.state || !parsed.codeVerifier || !parsed.returnTo) return null;
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return parsed;
  }
  return null;
}

export function clearAuthPendingCookie(secure: boolean): string {
  return `${PAPR_AUTH_PENDING_COOKIE}=; ${cookieSuffix(0, secure, "/")}`;
}

export function buildShareTokenCookie(
  shareToken: string,
  namespaceId: string,
  slug: string,
  secure: boolean,
): string {
  const secret = getCookieSigningSecret();
  const value = encodeSignedJson(
    {
      shareToken,
      namespaceId,
      slug,
      exp: Date.now() + SHARE_MAX_AGE_SEC * 1000,
    },
    secret,
  );
  // SameSite=None so invite links work in embedded previews (Paprwork Web tab iframe).
  // Path=/ so /api/db/* at site root receives the cookie (mini-apps use fetch('/api/...')).
  const sameSite = secure ? "None" : "Lax";
  const flags = `Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${SHARE_MAX_AGE_SEC}${secure ? "; Secure" : ""}`;
  return `${PAPR_SHARE_TOKEN_COOKIE}=${encodeURIComponent(value)}; ${flags}`;
}

export function readShareTokenFromCookie(
  cookieHeader: string | undefined,
  namespaceId: string,
  slug: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const secret = getCookieSigningSecret();
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${PAPR_SHARE_TOKEN_COOKIE}=`)) continue;
    const raw = decodeURIComponent(trimmed.slice(PAPR_SHARE_TOKEN_COOKIE.length + 1));
    const parsed = decodeSignedJson<{
      shareToken?: string;
      namespaceId?: string;
      slug?: string;
      exp?: number;
    }>(raw, secret);
    if (!parsed?.shareToken) return undefined;
    if (parsed.namespaceId !== namespaceId || parsed.slug !== slug) return undefined;
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return undefined;
    return parsed.shareToken;
  }
  return undefined;
}

export function sanitizeReturnToPath(returnTo: string | undefined): string {
  if (!returnTo || !returnTo.startsWith("/")) return "/";
  if (returnTo.startsWith("//")) return "/";
  if (returnTo.includes("://")) return "/";
  return returnTo;
}

export function isBrowsableCloudReturnToPath(path: string): boolean {
  const normalized = sanitizeReturnToPath(path.split("?")[0]);
  if (normalized === "/") {
    return false;
  }
  for (const prefix of NON_BROWSABLE_RETURN_TO_PREFIXES) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return false;
    }
  }
  return true;
}

export function cloudAppRootPath(namespaceId: string, slug: string): string {
  return publishedAppBaseHref(namespaceId, slug);
}

export function resolveCloudAuthReturnToPath(
  candidate: string | undefined,
  fallback?: { namespaceId?: string; slug?: string },
): string {
  const sanitized = sanitizeReturnToPath(candidate?.split("?")[0]);
  if (isBrowsableCloudReturnToPath(sanitized)) {
    return ensurePublishedAppRootTrailingSlash(sanitized);
  }
  if (fallback?.namespaceId && fallback.slug) {
    return cloudAppRootPath(fallback.namespaceId, fallback.slug);
  }
  return "/";
}

export function resolveCloudAuthReturnToFromRequest(
  req: {
    originalUrl?: string;
    headers?: { referer?: string };
  },
  fallback?: { namespaceId?: string; slug?: string },
): string {
  const referer = req.headers?.referer;
  if (referer) {
    try {
      const refPath = new URL(referer).pathname;
      if (isBrowsableCloudReturnToPath(refPath)) {
        return ensurePublishedAppRootTrailingSlash(refPath);
      }
    } catch {
      /* ignore malformed referer */
    }
  }

  const fromUrl = req.originalUrl?.split("?")[0];
  return resolveCloudAuthReturnToPath(fromUrl, fallback);
}

export function stripShareTokenFromPath(originalUrl: string): string {
  const qIndex = originalUrl.indexOf("?");
  const path = qIndex === -1 ? originalUrl : originalUrl.slice(0, qIndex);
  const query = qIndex === -1 ? "" : originalUrl.slice(qIndex + 1);
  const params = new URLSearchParams(query);
  params.delete("t");
  const normalizedPath = ensurePublishedAppRootTrailingSlash(path);
  const nextQuery = params.toString();
  return nextQuery ? `${normalizedPath}?${nextQuery}` : normalizedPath;
}
