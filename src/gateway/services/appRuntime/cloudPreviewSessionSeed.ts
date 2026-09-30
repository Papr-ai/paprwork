/**
 * Seed apps.papr.ai session cookies for desktop direct iframe preview.
 */

import type { Express } from "express";
import { getApiKey } from "../../utils/keyResolver.js";
import { getPaprUserId } from "../../utils/paprUserId.js";
import { buildCloudPreviewAuthHeaders } from "./cloudPreviewRuntimeAuth.js";
import type { CloudRouteContext } from "./cloudAppHostContext.js";

const CLOUD_APPS_HOST =
  process.env.PAPR_CLOUD_APPS_HOST?.replace(/\/$/, "") ?? "https://apps.papr.ai";

const SEED_TTL_MS = 5 * 60 * 1000;
const seedCache = new Map<string, { expiresAt: number }>();

export interface CloudPreviewSeedCookie {
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "lax" | "none" | "strict" | "unspecified";
  expirationDate?: number;
}

export interface CloudPreviewSeedResult {
  success: boolean;
  cached?: boolean;
  cookies?: CloudPreviewSeedCookie[];
  error?: string;
}

function seedCacheKey(ctx: CloudRouteContext): string {
  return `${ctx.namespaceId}:${ctx.slug}:${ctx.shareToken ?? ""}`;
}

function parseCookieAttributes(setCookieHeader: string): CloudPreviewSeedCookie | null {
  const segments = setCookieHeader.split(";").map((part) => part.trim());
  const nameValue = segments[0];
  if (!nameValue) return null;
  const eq = nameValue.indexOf("=");
  if (eq <= 0) return null;

  const name = nameValue.slice(0, eq).trim();
  const rawValue = nameValue.slice(eq + 1).trim();
  if (!name) return null;

  let path = "/";
  let secure = false;
  let httpOnly = false;
  let sameSite: CloudPreviewSeedCookie["sameSite"] = "lax";
  let maxAgeSec: number | undefined;

  for (const segment of segments.slice(1)) {
    const lower = segment.toLowerCase();
    if (lower === "secure") {
      secure = true;
      continue;
    }
    if (lower === "httponly") {
      httpOnly = true;
      continue;
    }
    if (lower.startsWith("path=")) {
      path = segment.slice(5).trim() || "/";
      continue;
    }
    if (lower.startsWith("max-age=")) {
      const parsed = Number.parseInt(segment.slice(8).trim(), 10);
      if (Number.isFinite(parsed)) {
        maxAgeSec = parsed;
      }
      continue;
    }
    if (lower.startsWith("samesite=")) {
      const value = segment.slice(9).trim().toLowerCase();
      if (value === "none" || value === "strict" || value === "lax") {
        sameSite = value;
      }
    }
  }

  let value = rawValue;
  try {
    value = decodeURIComponent(rawValue);
  } catch {
    value = rawValue;
  }

  const expirationDate =
    maxAgeSec !== undefined && maxAgeSec > 0
      ? Math.floor(Date.now() / 1000) + maxAgeSec
      : undefined;

  return {
    name,
    value,
    path,
    secure,
    httpOnly,
    sameSite,
    expirationDate,
  };
}

function readSetCookieHeaders(response: globalThis.Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

export async function seedCloudPreviewSession(
  ctx: CloudRouteContext,
  options?: { force?: boolean },
): Promise<CloudPreviewSeedResult> {
  const cacheKey = seedCacheKey(ctx);
  const cached = seedCache.get(cacheKey);
  if (!options?.force && cached && Date.now() < cached.expiresAt) {
    return { success: true, cached: true };
  }

  const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
  if (!sessionToken?.trim()) {
    return { success: false, error: "Papr login required" };
  }

  const returnTo = `/${ctx.namespaceId}/${ctx.slug}/`;
  const bridgeUrl = `${CLOUD_APPS_HOST}/auth/desktop-bridge?returnTo=${encodeURIComponent(returnTo)}`;

  const authHeaders = await buildCloudPreviewAuthHeaders(ctx, {
    auth: {
      namespaceId: ctx.namespaceId,
      slug: ctx.slug,
      sessionToken: sessionToken.trim(),
      externalUserId: getPaprUserId() ?? undefined,
      shareToken: ctx.shareToken,
    },
  });

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(bridgeUrl, {
      method: "GET",
      redirect: "manual",
      headers: authHeaders,
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Bridge request failed",
    };
  }

  if (upstream.status !== 302 && upstream.status !== 200) {
    const body = await upstream.text().catch(() => "");
    return {
      success: false,
      error: body.slice(0, 200) || `Bridge returned ${upstream.status}`,
    };
  }

  const parsedCookies = readSetCookieHeaders(upstream)
    .map(parseCookieAttributes)
    .filter((cookie): cookie is CloudPreviewSeedCookie => cookie !== null)
    .filter(
      (cookie) =>
        cookie.value.length > 0 &&
        (cookie.name === "papr_session" || cookie.name === "papr_share"),
    );

  if (parsedCookies.length === 0) {
    return {
      success: false,
      error: "Bridge did not return session cookies (deploy apps.papr.ai with /auth/desktop-bridge)",
    };
  }

  seedCache.set(cacheKey, { expiresAt: Date.now() + SEED_TTL_MS });
  return { success: true, cookies: parsedCookies };
}

export function registerCloudPreviewSessionSeedRoute(app: Express): void {
  app.post("/api/cloud-preview/seed-session", (req, res) => {
    void (async () => {
      const body = req.body as {
        namespaceId?: string;
        slug?: string;
        shareToken?: string;
        force?: boolean;
      };
      const namespaceId = body.namespaceId?.trim();
      const slug = body.slug?.trim();
      if (!namespaceId || !slug) {
        res.status(400).json({ success: false, error: "namespaceId and slug required" });
        return;
      }

      const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
      if (!sessionToken?.trim()) {
        res.status(401).json({ success: false, error: "Papr login required" });
        return;
      }

      const result = await seedCloudPreviewSession(
        {
          namespaceId,
          slug,
          shareToken: body.shareToken?.trim() || undefined,
        },
        { force: body.force === true },
      );
      if (!result.success) {
        res.status(result.error?.includes("deploy") ? 503 : 401).json(result);
        return;
      }
      res.json(result);
    })().catch((err: unknown) => {
      console.error("[Gateway] cloud-preview seed-session error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: err instanceof Error ? err.message : "seed failed",
        });
      }
    });
  });
}
