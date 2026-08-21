/**
 * Desktop Web preview — proxy apps.papr.ai through the local gateway with
 * Paprwork credentials (PAPR_API_KEY / PAPR_SESSION_TOKEN) so owners do not
 * need a separate apps.papr.ai browser login inside the iframe.
 */

import type { Express, Request, Response } from "express";
import { injectPublishedAppBaseHref } from "../../../core/utils/cloudAppPath.js";
import { getApiKey } from "../../utils/keyResolver.js";
import {
  isReservedCloudPathSegment,
  type CloudRouteContext,
} from "./cloudAppHostContext.js";
import { resolvePublishedApp } from "./cloudAppPublishClient.js";
import {
  buildCloudPreviewAuthHeaders,
  isCloudShareGateHtml,
  resolveCloudPreviewRuntimeAuth,
} from "./cloudPreviewRuntimeAuth.js";
import {
  buildDesktopCloudPreviewAccessResponse,
  validateDesktopCloudPreviewAccess,
} from "./cloudPreviewDesktopAccess.js";

const CLOUD_APPS_HOST =
  process.env.PAPR_CLOUD_APPS_HOST?.replace(/\/$/, "") ?? "https://apps.papr.ai";

/** Legacy cookie — cleared on Local switch; no longer used for API routing. */
export const CLOUD_PREVIEW_COOKIE = "papr_cloud_preview";

const RESOLVED_APP_ID_TTL_MS = 60_000;
const resolvedAppIdCache = new Map<
  string,
  { appId: string; expiresAt: number }
>();

export function parsePublishedAppUrl(url: string): {
  namespaceId: string;
  slug: string;
  shareToken?: string;
} | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const namespaceId = segments[0];
    const slug = segments[1];
    if (isReservedCloudPathSegment(namespaceId)) return null;
    const shareToken = parsed.searchParams.get("t") ?? undefined;
    return { namespaceId, slug, shareToken };
  } catch {
    return null;
  }
}

export function buildDesktopCloudPreviewUrl(
  gatewayBase: string,
  publishedUrl: string,
): string | null {
  const parsed = parsePublishedAppUrl(publishedUrl);
  if (!parsed) return null;
  const base = gatewayBase.replace(/\/$/, "");
  const query = parsed.shareToken
    ? `?t=${encodeURIComponent(parsed.shareToken)}`
    : "";
  return `${base}/cloud-preview/${parsed.namespaceId}/${parsed.slug}/${query}`;
}

function previewBasePath(ctx: CloudRouteContext): string {
  return `/cloud-preview/${ctx.namespaceId}/${ctx.slug}/`;
}

function resolveCloudPreviewContextFromReferer(
  referer: string | undefined,
): CloudRouteContext | null {
  if (!referer) return null;
  try {
    const url = new URL(referer);
    const match = url.pathname.match(/^\/cloud-preview\/([^/]+)\/([^/]+)\/?/);
    if (!match?.[1] || !match[2]) return null;
    const shareToken = url.searchParams.get("t")?.trim() || undefined;
    return { namespaceId: match[1], slug: match[2], shareToken };
  } catch {
    return null;
  }
}

/**
 * Route /api/* to cloud only when the request originates from a cloud-preview
 * iframe (Referer contains /cloud-preview/). Cookie-based routing was removed
 * because Path=/ cookies leaked into Local preview after switching modes.
 */
export function getCloudPreviewContextForApi(req: Request): CloudRouteContext | null {
  return resolveCloudPreviewContextFromReferer(
    typeof req.headers.referer === "string" ? req.headers.referer : undefined,
  );
}

const PROXYABLE_API_PREFIXES = [
  "/api/access",
  "/api/members",
  "/api/db/",
  "/api/bash/run",
  "/api/app/backend/",
  "/api/jobs/list",
  "/api/jobs/status/",
  "/api/jobs/run",
  "/api/credentials/client-keys",
  "/api/app-agent/",
  "/api/apps/",
] as const;

export function isCloudProxyableApiPath(path: string): boolean {
  return PROXYABLE_API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix),
  );
}

async function resolveCloudAppId(ctx: CloudRouteContext): Promise<string | undefined> {
  const cacheKey = `${ctx.namespaceId}:${ctx.slug}`;
  const cached = resolvedAppIdCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.appId;
  }
  const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
  const resolved = await resolvePublishedApp(
    ctx.namespaceId,
    ctx.slug,
    sessionToken ?? undefined,
  );
  if (!resolved?.appId) return undefined;
  resolvedAppIdCache.set(cacheKey, {
    appId: resolved.appId,
    expiresAt: Date.now() + RESOLVED_APP_ID_TTL_MS,
  });
  return resolved.appId;
}

function apiPathNeedsAppId(path: string): boolean {
  return (
    path.startsWith("/api/db/") ||
    path.startsWith("/api/app/backend/") ||
    path.startsWith("/api/jobs/") ||
    path.startsWith("/api/app-agent/")
  );
}

async function buildProxiedApiUrl(
  req: Request,
  ctx: CloudRouteContext,
): Promise<string> {
  const queryIndex = req.url.indexOf("?");
  const query = queryIndex >= 0 ? req.url.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(query);

  if (apiPathNeedsAppId(req.path) && !params.get("appId")) {
    const appId = await resolveCloudAppId(ctx);
    if (appId) params.set("appId", appId);
  }

  const serialized = params.toString();
  return `${CLOUD_APPS_HOST}${req.path}${serialized ? `?${serialized}` : ""}`;
}

async function buildProxiedApiBody(
  req: Request,
  ctx: CloudRouteContext,
): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD" || req.body === undefined) {
    return undefined;
  }
  if (!apiPathNeedsAppId(req.path)) {
    return JSON.stringify(req.body);
  }
  const body =
    typeof req.body === "object" && req.body !== null
      ? { ...(req.body as Record<string, unknown>) }
      : {};
  if (!body.appId) {
    const appId = await resolveCloudAppId(ctx);
    if (appId) body.appId = appId;
  }
  return JSON.stringify(body);
}

function rewriteHtmlBaseHref(html: string, ctx: CloudRouteContext): string {
  const previewBase = previewBasePath(ctx);
  const cloudBase = `/${ctx.namespaceId}/${ctx.slug}/`;
  if (html.includes(`href="${cloudBase}"`)) {
    return html.replace(`href="${cloudBase}"`, `href="${previewBase}"`);
  }
  return injectPublishedAppBaseHref(html, previewBase);
}

function cloudPreviewContextFromParams(
  namespaceId: string,
  slug: string,
  shareToken?: string,
): CloudRouteContext | null {
  if (!namespaceId || !slug) return null;
  if (isReservedCloudPathSegment(namespaceId)) return null;
  return { namespaceId, slug, shareToken };
}

export async function proxyCloudStaticRequest(
  req: Request,
  res: Response,
  ctx: CloudRouteContext,
  subPath: string,
): Promise<void> {
  const runtimeAuth = await resolveCloudPreviewRuntimeAuth(ctx);
  const localAccess = await validateDesktopCloudPreviewAccess(runtimeAuth);

  const queryIndex = req.url.indexOf("?");
  const query = queryIndex >= 0 ? req.url.slice(queryIndex) : "";
  const targetPath = subPath.length > 0 ? subPath : "index.html";
  const targetUrl = `${CLOUD_APPS_HOST}/${ctx.namespaceId}/${ctx.slug}/${targetPath}${query}`;

  const acceptHeader =
    typeof req.headers.accept === "string" ? req.headers.accept : "*/*";

  async function fetchUpstream(
    enrichFromSession: boolean,
  ): Promise<globalThis.Response> {
    const authHeaders = await buildCloudPreviewAuthHeaders(ctx, {
      enrichFromSession,
    });
    return fetch(targetUrl, {
      method: req.method,
      headers: {
        ...authHeaders,
        Accept: acceptHeader,
      },
      redirect: "manual",
    });
  }

  let upstreamRes = await fetchUpstream(false);
  let body = Buffer.from(await upstreamRes.arrayBuffer());
  let resolvedContentType = upstreamRes.headers.get("content-type") ?? "";

  if (resolvedContentType.includes("text/html") && localAccess?.canRead) {
    const html = body.toString("utf8");
    if (isCloudShareGateHtml(html)) {
      upstreamRes = await fetchUpstream(true);
      body = Buffer.from(await upstreamRes.arrayBuffer());
      resolvedContentType = upstreamRes.headers.get("content-type") ?? resolvedContentType;
    }
  }

  if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
    const location = upstreamRes.headers.get("location");
    if (location) {
      res.redirect(upstreamRes.status, location);
      return;
    }
  }

  if (resolvedContentType.includes("text/html")) {
    const html = rewriteHtmlBaseHref(body.toString("utf8"), ctx);
    body = Buffer.from(html, "utf8");
  }

  res.status(upstreamRes.status);
  if (resolvedContentType) {
    res.setHeader("Content-Type", resolvedContentType);
  }
  res.send(body);
}

export async function proxyCloudApiRequest(
  req: Request,
  res: Response,
  ctx: CloudRouteContext,
): Promise<void> {
  const runtimeAuth = await resolveCloudPreviewRuntimeAuth(ctx);
  const authHeaders = await buildCloudPreviewAuthHeaders(ctx, {
    enrichFromSession: Boolean(runtimeAuth.sessionToken),
  });
  const targetUrl = await buildProxiedApiUrl(req, ctx);

  const headers: Record<string, string> = {
    ...authHeaders,
    Accept: typeof req.headers.accept === "string" ? req.headers.accept : "*/*",
  };
  const contentType = req.headers["content-type"];
  if (typeof contentType === "string") {
    headers["Content-Type"] = contentType;
  }

  const init: RequestInit = {
    method: req.method,
    headers,
  };
  const body = await buildProxiedApiBody(req, ctx);
  if (body !== undefined) {
    init.body = body;
  }

  const upstream = await fetch(targetUrl, init);
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") return;
    res.setHeader(key, value);
  });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.send(buffer);
}

function routeParam(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

export function registerCloudDesktopPreviewRoutes(app: Express): void {
  const handlePreview = (req: Request, res: Response): void => {
    const namespaceId = routeParam(req.params.namespaceId);
    const slug = routeParam(req.params.slug);
    if (!namespaceId || !slug) {
      res.status(404).send("Not found");
      return;
    }
    const shareToken =
      typeof req.query.t === "string" ? req.query.t.trim() || undefined : undefined;
    const ctx = cloudPreviewContextFromParams(namespaceId, slug, shareToken);
    if (!ctx) {
      res.status(404).send("Not found");
      return;
    }
    const splatParam = (req.params as { splat?: string | string[] }).splat;
    const splat = Array.isArray(splatParam) ? splatParam.join("/") : splatParam;
    const subPath = typeof splat === "string" ? splat : "";
    void proxyCloudStaticRequest(req, res, ctx, subPath).catch((err: unknown) => {
      console.error("[Gateway] cloud-preview static proxy error:", err);
      if (!res.headersSent) {
        res.status(502).send("Cloud preview unavailable");
      }
    });
  };

  app.get("/cloud-preview/:namespaceId/:slug", handlePreview);
  app.get("/cloud-preview/:namespaceId/:slug/*splat", handlePreview);
}

export function registerCloudDesktopPreviewApiProxy(app: Express): void {
  app.use((req, res, next) => {
    if (req.method === "OPTIONS") {
      next();
      return;
    }
    if (!isCloudProxyableApiPath(req.path)) {
      next();
      return;
    }
    const ctx = getCloudPreviewContextForApi(req);
    if (!ctx) {
      next();
      return;
    }

    if (req.method === "GET" && req.path === "/api/access") {
      void buildDesktopCloudPreviewAccessResponse(ctx)
        .then((body) => {
          res.json(body);
        })
        .catch((err: unknown) => {
          console.error("[Gateway] cloud-preview /api/access error:", err);
          if (!res.headersSent) {
            res.status(500).json({ error: (err as Error).message });
          }
        });
      return;
    }

    void proxyCloudApiRequest(req, res, ctx).catch((err: unknown) => {
      console.error("[Gateway] cloud-preview API proxy error:", err);
      if (!res.headersSent) {
        res.status(502).json({ error: "Cloud preview API unavailable" });
      }
    });
  });
}
