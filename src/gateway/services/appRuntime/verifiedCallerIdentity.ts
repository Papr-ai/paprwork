/**
 * Verified caller identity for Cloud App Host.
 *
 * The caller's user id decides per-user database routing, owner checks and
 * row ACLs, so it must never come from something the browser can set freely.
 *
 * Trusted sources, in order:
 *   1. Signed `papr_session` cookie (minted after Auth0 code exchange).
 *   2. `X-Session-Token` header, validated against Parse (/users/me).
 *
 * The `x-papr-external-user-id` header is NEVER trusted on its own. It is only
 * accepted when it equals the id proven by (1) or (2); otherwise it is dropped.
 */

import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { readCloudAppSessionFromCookie } from "./cloudAppHostCookies.js";
import { headerExternalUserId, headerSessionToken } from "./cloudAppHostContext.js";
import { validateParseSessionToken } from "./validateParseSessionToken.js";

export interface VerifiedCaller {
  userId?: string;
  sessionToken?: string;
  email?: string;
  /** Header claimed an id that did not match the verified one. */
  rejectedClaim?: boolean;
}

type Validator = (token: string) => Promise<{ objectId: string; email?: string } | null>;

const OK_TTL_MS = 5 * 60_000;
const BAD_TTL_MS = 30_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { objectId: string | null; email?: string; exp: number }>();

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function verifySessionToken(
  token: string,
  validate: Validator,
  now: number,
): Promise<{ objectId: string; email?: string } | null> {
  const key = tokenKey(token);
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.objectId ? { objectId: hit.objectId, email: hit.email } : null;
  const user = await validate(token);
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, {
    objectId: user?.objectId ?? null,
    email: user?.email,
    exp: now + (user ? OK_TTL_MS : BAD_TTL_MS),
  });
  return user;
}

export async function resolveVerifiedCaller(
  req: Pick<Request, "headers">,
  validate: Validator = validateParseSessionToken,
  now = Date.now(),
): Promise<VerifiedCaller> {
  const claimed = headerExternalUserId(req.headers)?.trim();
  const cookie = readCloudAppSessionFromCookie(req.headers.cookie);

  let proven: VerifiedCaller = {};
  if (cookie?.sessionToken) {
    proven = { userId: cookie.externalUserId, sessionToken: cookie.sessionToken, email: cookie.email };
  } else {
    const token = headerSessionToken(req.headers)?.trim();
    if (token) {
      const user = await verifySessionToken(token, validate, now);
      if (user) proven = { userId: user.objectId, sessionToken: token, email: user.email };
    }
  }

  if (claimed && claimed !== proven.userId) {
    return { ...proven, rejectedClaim: true };
  }
  return proven;
}

const VERIFIED = Symbol.for("papr.verifiedCaller");

export function getVerifiedCaller(req: Request): VerifiedCaller | undefined {
  return (req as unknown as Record<symbol, VerifiedCaller | undefined>)[VERIFIED];
}

/** Express middleware: run once per request, before any route reads identity. */
export function verifiedCallerMiddleware(validate: Validator = validateParseSessionToken) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    resolveVerifiedCaller(req, validate)
      .then((caller) => {
        (req as unknown as Record<symbol, VerifiedCaller>)[VERIFIED] = caller;
        if (caller.rejectedClaim) {
          console.warn("[CloudAppHost] dropped unverified x-papr-external-user-id claim");
        }
        next();
      })
      .catch(() => {
        (req as unknown as Record<symbol, VerifiedCaller>)[VERIFIED] = {};
        next();
      });
  };
}

/** Test hook. */
export function clearVerifiedCallerCache(): void {
  cache.clear();
}
