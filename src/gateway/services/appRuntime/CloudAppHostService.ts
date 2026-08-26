/**
 * Cloud App Host — orchestrates git-backed app files + Turso DB proxy.
 * Deploy standalone via cloud-app-host.ts (apps.papr.ai).
 */

import type { Express, Request, Response } from "express";
import path from "path";
import type {
  AppAccessContext,
  AppPublishResolver,
  AppRuntimeRouteAuth,
  TursoCredentialsProvider,
} from "./types.js";
import type { AppFileRow } from "../appFiles/appFilesSchema.js";
import { TursoDbAdapter } from "./TursoDbAdapter.js";
import { getJobEventHub } from "../JobEventHub.js";
import { publishDbChanged } from "../../utils/publishJobRunEvents.js";
import { registerJobEventsSseRoutes } from "../registerJobEventsSse.js";
import { registerAppAgentChatRoutes } from "../appAgentChat/registerAppAgentChatRoutes.js";
import { getMemoryAppAgentChatSessionStore } from "../appAgentChat/AppAgentChatSessionStore.js";
import { registerPaprMiniAppSdkRoutes } from "../../utils/registerPaprMiniAppSdkRoutes.js";
import {
  publishJobOutputProgress,
  publishJobStatusChanged,
} from "../../utils/publishJobRunEvents.js";
import {
  assertExecSql,
  assertReadOnlySql,
  assertWriteSql,
} from "./sqlValidation.js";
import { type AppDataSourcesFile } from "../appDataSources.js";
import { resolveDbEventTarget } from "../../utils/resolveDbEventTarget.js";
import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import {
  fetchRuntimeDbToken,
  getCloudAppHostKey,
  getRuntimeJobStatus,
  listRuntimeJobs,
  recordRuntimeTursoDbChanged,
  runRuntimeJob,
  runtimeFetch,
} from "./memoryRuntimeClient.js";
import { CloudAppBackendService } from "./CloudAppBackendService.js";
import {
  MINI_APP_BASH_DISABLED_CODE,
  MINI_APP_BASH_DISABLED_MESSAGE,
} from "./miniAppApiPolicy.js";
import {
  cacheControlForAppAsset,
  fetchCachedRuntimeRepoFile,
  getCachedTranspiledTypeScript,
  invalidateRepoCacheForPublishedApp,
  invalidateRepoCacheForNamespace,
  validateCachedAccess,
} from "./cloudAppHostCache.js";
import { shouldBypassRepoFileCache } from "./cloudAppHostRequestCache.js";
import {
  cloudContextCookieHeaders,
  injectPaprCloudContextMeta,
  isReservedCloudPathSegment,
  resolveCloudRouteContext,
} from "./cloudAppHostContext.js";
import { enrichRuntimeAuthWithPaprApiKey } from "./resolveCloudSessionPaprApiKey.js";
import { CloudAppHostAuthService } from "./CloudAppHostAuthService.js";
import { CloudAppHostCredentialService } from "./CloudAppHostCredentialService.js";
import {
  buildShareTokenCookie,
  readShareTokenFromCookie,
  resolveCloudAuthReturnToFromRequest,
} from "./cloudAppHostCookies.js";
import {
  ensurePublishedAppRootTrailingSlash,
  injectPublishedAppBaseHref,
  isPublishedAppRootPath,
  publishedAppBaseHref,
} from "../../../core/utils/cloudAppPath.js";
import {
  resolvePublishedApp,
  visibilityRequiresPaprLogin,
  visibilityRequiresShareToken,
} from "./cloudAppPublishClient.js";
import { getMiniAppContentType } from "../../utils/miniAppStaticAssets.js";
import {
  buildMiniAppAccessResponse,
  mergeVerifiedCallerJobParams,
} from "./miniAppAccess.js";
import { configHasPerUserLinkedSources } from "./cloudAppPerUserAccess.js";
import {
  assertMiniAppMembersAccess,
  listMiniAppMembers,
  MiniAppMembersError,
} from "./miniAppMembers.js";
import {
  buildDbCacheKey,
  checkDbRateLimit,
  dbRateLimitKey,
  getCachedDbResult,
  invalidateDbCacheForApp,
  setCachedDbResult,
} from "./dbRequestGuard.js";
import { isMiniAppTypeScriptFile } from "../../utils/miniAppTranspile.js";
import { buildCloudAuthLoginUrl, isLinkPreviewCrawler } from "../../../core/utils/cloudAppPreview.js";
import {
  buildShareGateLandingHtml,
  resolveShareGatePresentation,
  getCloudAppPublicBaseUrl,
  injectCloudAppPreviewIntoHtml,
  resolveCloudAppPreviewMeta,
  resolvePreviewIconSvg,
} from "./CloudAppPreviewService.js";
import {
  PAPR_APP_META_RELATIVE_PATH,
  readCloudAppMetaFromContent,
} from "../cloudSync/cloudAppMeta.js";
import { normalizeRequiredSchemaVersion } from "../jobs/migrationLedgerPolicy.js";
import {
  evaluateCloudAppSchemaGate,
} from "./cloudAppSchemaGate.js";
import {
  injectPaprAppRevisionMeta,
  resolvePublishedAppRevision,
} from "./publishedAppRevision.js";
import { loadAppDataSourcesConfig } from "./cloudDatabaseRegistry.js";

export interface CloudAppHostDeps {
  tursoCredentials: TursoCredentialsProvider;
  publishResolver: AppPublishResolver;
}

export class MemoryServerTursoCredentials implements TursoCredentialsProvider {
  async getUserDatabaseToken(
    _orgId: string,
    _namespaceId: string,
    _userId: string,
    runtimeAuth: AppRuntimeRouteAuth,
    database: string,
  ): Promise<{ tursoUrl: string; authToken: string }> {
    return fetchRuntimeDbToken(runtimeAuth, database);
  }
}

export class MemoryServerPublishResolver implements AppPublishResolver {
  async validateAccess(input: {
    namespaceId: string;
    slug: string;
    paprApiKey?: string;
    sessionToken?: string;
    shareToken?: string;
    externalUserId?: string;
  }): Promise<AppAccessContext | null> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (input.paprApiKey) {
      headers["X-API-Key"] = input.paprApiKey;
    }
    if (input.sessionToken) {
      headers["X-Session-Token"] = input.sessionToken;
    }

    const res = await runtimeFetch(`${getMemoryServerBaseUrl()}/v1/cloud/apps/access/validate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        namespaceId: input.namespaceId,
        slug: input.slug,
        paprApiKey: input.paprApiKey,
        shareToken: input.shareToken,
        ...(input.sessionToken ? { sessionToken: input.sessionToken } : {}),
        ...(input.externalUserId ? { external_user_id: input.externalUserId } : {}),
      }),
    });
    if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Access validate failed: ${res.status}`);
    }
    const json = (await res.json()) as {
      orgId: string;
      namespaceId: string;
      userId: string;
      appId: string;
      mode: AppAccessContext["mode"];
      canRead: boolean;
      canWrite: boolean;
    };
    return {
      orgId: json.orgId,
      namespaceId: json.namespaceId,
      userId: json.userId,
      appId: json.appId,
      mode: json.mode,
      canRead: json.canRead,
      canWrite: json.canWrite,
    };
  }
}

function getShareToken(req: Request, namespaceId?: string, slug?: string): string | undefined {
  const header = req.headers["x-papr-share-token"];
  if (typeof header === "string" && header.length > 0) return header;
  if (namespaceId && slug) {
    const fromCookie = readShareTokenFromCookie(req.headers.cookie, namespaceId, slug);
    if (fromCookie) return fromCookie;
  }
  const query = req.query["t"];
  return typeof query === "string" ? query : undefined;
}

function getRequestPaprApiKey(req: Request): string | undefined {
  const header = req.headers["x-api-key"];
  if (typeof header === "string") return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

/** Exposed as Server-Timing for E2E / browser devtools (Phase 1 perf tracking). */
function setCloudDbServerTiming(
  res: Response,
  parts: Record<string, number | string>,
): void {
  const header = Object.entries(parts)
    .map(([name, value]) =>
      typeof value === "number"
        ? `${name};dur=${Math.round(value)}`
        : `${name};desc="${String(value).replace(/"/g, "")}"`,
    )
    .join(", ");
  if (header) {
    res.setHeader("Server-Timing", header);
  }
}

function cloudHostCacheTimingParts(perf: {
  accessCacheHit: boolean;
  configCacheHit: boolean;
}): Record<string, string> {
  return {
    accessCache: perf.accessCacheHit ? "hit" : "miss",
    configCache: perf.configCacheHit ? "hit" : "miss",
  };
}

export class CloudAppHostService {
  private readonly turso: TursoDbAdapter;
  private readonly auth = new CloudAppHostAuthService();
  private readonly credentials = new CloudAppHostCredentialService((req) =>
    this.buildRuntimeAuth(req),
  );

  constructor(private readonly deps: CloudAppHostDeps) {
    this.turso = new TursoDbAdapter(deps.tursoCredentials);
  }

  registerRoutes(app: Express): void {
    this.auth.registerRoutes(app);
    this.credentials.registerRoutes(app);

    registerPaprMiniAppSdkRoutes(app);
    registerAppAgentChatRoutes(app, {
      mode: "cloud",
      sessionStore: getMemoryAppAgentChatSessionStore(),
      buildRuntimeAuth: (req) => this.buildRuntimeAuth(req),
      jobRunRequiresSignIn: (auth) => this.jobRunRequiresSignIn(auth),
      respondJobRunSignInRequired: (req, res) =>
        this.respondJobRunSignInRequired(req, res),
    });
    registerJobEventsSseRoutes(app, {
      hub: getJobEventHub(),
      pollJobStatus: async (jobId, req) => {
        const runtimeAuth = this.buildRuntimeAuth(req);
        if (!runtimeAuth) {
          return null;
        }
        try {
          const job = await getRuntimeJobStatus(runtimeAuth, jobId);
          if (!job) {
            return null;
          }
          return {
            jobId: job.id,
            name: job.name,
            status: job.status ?? "unknown",
            completedAt: job.completedAt,
            lastOutput: job.lastOutput,
          };
        } catch {
          return null;
        }
      },
    });

    app.get("/health", (_req, res) => {
      res.json({ status: "ok", service: "cloud-app-host" });
    });

    app.post("/internal/app-revision-updated", (req, res) =>
      void this.handleInternalAppRevisionUpdated(req, res),
    );

    app.post("/internal/app-repo-committed", (req, res) =>
      void this.handleInternalAppRepoCommitted(req, res),
    );

    app.post("/internal/db-changed", (req, res) =>
      void this.handleInternalDbChanged(req, res),
    );

    app.get("/api/access", (req, res) => void this.handleAccess(req, res));
    app.get("/api/members", (req, res) => void this.handleMembers(req, res));
    app.get("/api/db/schema", (req, res) => this.handleSchema(req, res));
    app.post("/api/db/query", (req, res) => this.handleQuery(req, res));
    const handleBatchQueryRoute = (req: Request, res: Response): void => {
      void this.handleBatchQuery(req, res);
    };
    app.post("/api/db/batch", handleBatchQueryRoute);
    app.post("/api/db/query-batch", handleBatchQueryRoute);
    app.post("/api/db/read-batch", handleBatchQueryRoute);
    app.post("/api/db/write", (req, res) => this.handleWrite(req, res));
    app.post("/api/db/write-batch", (req, res) => this.handleWriteBatch(req, res));
    app.post("/api/db/exec", (req, res) => this.handleExec(req, res));
    app.post("/api/bash/run", (req, res) => void this.handleBashRun(req, res));
    app.post("/api/app/backend/:action", (req, res) =>
      void this.handleBackendAction(req, res),
    );
    app.get("/api/jobs/list", (req, res) => void this.handleJobsList(req, res));
    app.get("/api/jobs/status/:jobId", (req, res) =>
      void this.handleJobStatus(req, res),
    );
    app.post("/api/jobs/run", (req, res) => void this.handleJobRun(req, res));
    app.post("/api/credentials/client-keys", (req, res) =>
      void this.handleClientKeys(req, res),
    );
    // Same path and body as the desktop gateway, so `papr.files.url(id)` is one
    // call that works in both runtimes. Without this a published app that
    // references a file 404s on apps.papr.ai.
    app.post("/api/files/url", (req, res) => void this.handleFileUrl(req, res));
    app.get("/api/files", (req, res) => void this.handleFileList(req, res));

    app.get("/:namespaceId/:slug/__papr__/app-revision.json", (req, res) => {
      if (isReservedCloudPathSegment(req.params.namespaceId)) {
        res.status(404).send("Not found");
        return;
      }
      this.setCloudContextCookies(req, res);
      void this.handleAppRevision(req, res);
    });

    app.get("/:namespaceId/:slug", (req, res) => {
      if (isReservedCloudPathSegment(req.params.namespaceId)) {
        res.status(404).send("Not found");
        return;
      }
      this.setCloudContextCookies(req, res);
      void this.handlePublishedAppFile(req, res, "index.html");
    });

    app.get("/:namespaceId/:slug/*splat", (req, res) => {
      if (isReservedCloudPathSegment(req.params.namespaceId)) {
        res.status(404).send("Not found");
        return;
      }
      this.setCloudContextCookies(req, res);
      const splatParam = (req.params as { splat?: string | string[] }).splat;
      const splat = Array.isArray(splatParam) ? splatParam.join("/") : splatParam;
      const requestedPath =
        typeof splat === "string" && splat.length > 0 ? splat : "index.html";
      void this.handlePublishedAppFile(req, res, requestedPath);
    });

    app.get(/^\/apps\/([^/]+)\/?(.*)$/, (req, res) => this.handleAppFile(req, res));
  }

  private setCloudContextCookies(req: Request, res: Response): void {
    const ctx = resolveCloudRouteContext({
      params: req.params,
      query: req.query as Record<string, unknown>,
    });
    if (!ctx) return;
    const secure = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
    for (const cookie of cloudContextCookieHeaders(ctx.namespaceId, ctx.slug, secure)) {
      res.append("Set-Cookie", cookie);
    }
  }

  private getCloudRouteContext(req: Request): ReturnType<typeof resolveCloudRouteContext> {
    return resolveCloudRouteContext({
      params: req.params,
      query: req.query as Record<string, unknown>,
      cookieHeader: req.headers.cookie,
      headers: req.headers,
    });
  }

  private buildRuntimeAuth(req: Request): AppRuntimeRouteAuth | null {
    const ctx = this.getCloudRouteContext(req);
    if (!ctx) return null;
    return {
      namespaceId: ctx.namespaceId,
      slug: ctx.slug,
      paprApiKey: getRequestPaprApiKey(req),
      sessionToken: this.auth.getSessionToken(req),
      shareToken: getShareToken(req, ctx.namespaceId, ctx.slug),
      externalUserId: this.auth.getExternalUserId(req),
    };
  }

  /**
   * Turso replica actors: publisher (shared DBs) + session caller (per-user DBs).
   */
  private tursoDbRequest(
    access: AppAccessContext,
    runtimeAuth: AppRuntimeRouteAuth,
  ): { userId: string; callerUserId?: string } {
    return {
      userId: access.userId,
      callerUserId: runtimeAuth.externalUserId,
    };
  }

  private callerIsSignedIn(runtimeAuth: AppRuntimeRouteAuth): boolean {
    return Boolean(
      runtimeAuth.sessionToken?.trim() || runtimeAuth.externalUserId?.trim(),
    );
  }

  private async accessBlockedForAnonymousPerUserData(
    runtimeAuth: AppRuntimeRouteAuth,
  ): Promise<boolean> {
    if (this.callerIsSignedIn(runtimeAuth)) {
      return false;
    }
    try {
      const config = await this.loadDataSources(runtimeAuth);
      return configHasPerUserLinkedSources(config);
    } catch {
      return false;
    }
  }

  /**
   * Rate-limit guard for /api/db/* endpoints. Returns true when the request
   * may proceed; otherwise responds 429 with Retry-After.
   */
  private enforceDbRateLimit(
    req: Request,
    res: Response,
    kind: "read" | "write",
    weight = 1,
  ): boolean {
    const runtimeAuth = this.buildRuntimeAuth(req);
    const key = dbRateLimitKey({
      sessionToken: runtimeAuth?.sessionToken,
      shareToken: runtimeAuth?.shareToken,
      paprApiKey: runtimeAuth?.paprApiKey,
      ip: req.ip,
    });
    const check = checkDbRateLimit(key, kind, weight);
    if (!check.allowed) {
      res.setHeader("Retry-After", String(check.retryAfterSec));
      res.status(429).json({
        error: "Too many database requests — slow down or use subscribeJobEvents({ onDbChanged }) instead of polling.",
        retryAfterSec: check.retryAfterSec,
      });
      return false;
    }
    return true;
  }

  private requestIsSecure(req: Request): boolean {
    return req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
  }

  private maybeTrailingSlashRedirect(
    req: Request,
    res: Response,
    requestedPath: string,
  ): boolean {
    if (requestedPath !== "index.html") {
      return false;
    }
    const path = req.path;
    if (path.endsWith("/") || !isPublishedAppRootPath(path)) {
      return false;
    }
    const queryIndex = req.url.indexOf("?");
    const query = queryIndex === -1 ? "" : req.url.slice(queryIndex);
    res.redirect(308, `${ensurePublishedAppRootTrailingSlash(path)}${query}`);
    return true;
  }

  private maybeExchangeShareToken(req: Request, res: Response): boolean {
    const queryToken = req.query["t"];
    if (typeof queryToken !== "string" || queryToken.length === 0) {
      return false;
    }

    const userAgent = req.headers["user-agent"];
    if (isLinkPreviewCrawler(typeof userAgent === "string" ? userAgent : undefined)) {
      // Crawlers need ?t= on the URL for unfurl validation; they won't store cookies.
      return false;
    }

    const ctx = this.getCloudRouteContext(req);
    if (!ctx) return false;

    const secure = this.requestIsSecure(req);
    // Persist token for /api/* sub-requests, but keep ?t= in the URL so users can
    // copy, refresh, and embed (e.g. Paprwork Web preview iframe) without losing access.
    res.append(
      "Set-Cookie",
      buildShareTokenCookie(queryToken, ctx.namespaceId, ctx.slug, secure),
    );
    return false;
  }

  private async respondAccessDenied(
    req: Request,
    res: Response,
    runtimeAuth: AppRuntimeRouteAuth,
    options: { html?: boolean } = {},
  ): Promise<void> {
    const sessionToken = runtimeAuth.sessionToken;
    if (sessionToken) {
      if (options.html) {
        await this.sendShareGatePreview(req, res, runtimeAuth);
        return;
      }
      res.status(403).json({
        error: "access_denied",
        authenticated: true,
        message:
          "You are signed in, but this Papr account does not have access to this app.",
      });
      return;
    }

    const resolved = await resolvePublishedApp(
      runtimeAuth.namespaceId,
      runtimeAuth.slug,
      sessionToken,
    );

    const returnTo = resolveCloudAuthReturnToFromRequest(req, {
      namespaceId: runtimeAuth.namespaceId,
      slug: runtimeAuth.slug,
    });
    const loginUrl = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

    if (!resolved || visibilityRequiresPaprLogin(resolved.visibility, resolved.requireSignIn)) {
      if (options.html) {
        await this.sendShareGatePreview(req, res, runtimeAuth);
        return;
      }
      res.status(401).json({
        error: "authentication_required",
        authenticated: false,
        loginUrl,
        message: "You are not signed in. Sign in at apps.papr.ai to access this app.",
      });
      return;
    }

    if (resolved && visibilityRequiresShareToken(resolved.visibility)) {
      if (
        options.html &&
        (req.path.endsWith("/") || isPublishedAppRootPath(req.path))
      ) {
        await this.sendShareGatePreview(req, res, runtimeAuth);
        return;
      }
      const message = "This app requires a valid external share link.";
      if (options.html) {
        res.status(403).send(message);
      } else {
        res.status(403).json({ error: message });
      }
      return;
    }

    if (options.html) {
      res.status(403).send("Forbidden");
    } else {
      res.status(403).json({ error: "Forbidden" });
    }
  }

  /**
   * POST /api/files/url — resolve one App Files id to a URL a browser can use.
   *
   * Mirrors the desktop route so mini-app code is identical in both runtimes.
   * The difference is what can be returned: the desktop may hand back a local
   * path, whereas the cloud has no filesystem and must answer with a CDN URL
   * (published, app-scoped) or a short-lived signed URL (everything else).
   *
   * All of the judgement lives in `resolveCloudFileUrl`, which is pure and
   * tested exhaustively; this method only fetches the row and acts.
   */
  private async handleFileUrl(req: Request, res: Response): Promise<void> {
    try {
      const { appId: requestedAppId, sourceId, id } = req.body as {
        appId?: string;
        sourceId?: string;
        id?: string;
      };
      if (!id) {
        res.status(400).json({ error: "id is required" });
        return;
      }

      if (!this.enforceDbRateLimit(req, res, "read")) return;

      const ctx = await this.resolveDbAppContext(req, res, requestedAppId);
      if (!ctx) return;
      const { runtimeAuth, access, appId } = ctx;

      const config = await this.loadDataSources(runtimeAuth);
      const result = await this.turso.query({
        orgId: access.orgId,
        namespaceId: access.namespaceId,
        ...this.tursoDbRequest(access, runtimeAuth),
        runtimeAuth,
        config,
        sourceId,
        sql: "SELECT * FROM app_files WHERE id = ? LIMIT 1",
        params: [id],
      });

      // Turso hands back untyped rows; app_files is our own schema, so the
      // shape is known even though the adapter cannot express it.
      const row = (result?.rows?.[0] ?? null) as unknown as AppFileRow | null;
      const { resolveCloudFileUrl, buildCdnUrl } = await import(
        "../appFiles/cloudFileUrl.js"
      );

      const decision = resolveCloudFileUrl(row, {
        requestedAppId: appId,
        canRead: access.canRead,
        userId: runtimeAuth.externalUserId || null,
        isPublished: true,
      });

      if (decision.kind === "deny") {
        res.status(decision.status).json({ error: decision.reason });
        return;
      }

      if (decision.kind === "cdn") {
        res.json({
          location: { kind: "cloud" },
          url: buildCdnUrl(decision.objectKey),
        });
        return;
      }

      const { createReadUrl } = await import("../appFiles/appFilesClient.js");
      const { url } = await createReadUrl(decision.appId, decision.objectKey);
      res.json({ location: { kind: "cloud" }, url });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  /**
   * GET /api/files — list this app's files.
   *
   * Read-only on purpose. Uploading from a published cloud app would need the
   * visitor to hold write access to the owner's storage, which is a different
   * trust decision than viewing published assets; until that is designed,
   * cloud is read-only and the desktop remains the write path.
   */
  private async handleFileList(req: Request, res: Response): Promise<void> {
    try {
      const requestedAppId = req.query["appId"] as string | undefined;
      const sourceId = req.query["sourceId"] as string | undefined;
      if (!this.enforceDbRateLimit(req, res, "read")) return;

      const ctx = await this.resolveDbAppContext(req, res, requestedAppId);
      if (!ctx) return;
      const { runtimeAuth, access, appId } = ctx;

      if (!access.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth);
        return;
      }

      const config = await this.loadDataSources(runtimeAuth);
      const result = await this.turso.query({
        orgId: access.orgId,
        namespaceId: access.namespaceId,
        ...this.tursoDbRequest(access, runtimeAuth),
        runtimeAuth,
        config,
        sourceId,
        sql: `SELECT * FROM app_files WHERE app_id = ? ORDER BY created_at DESC`,
        params: [appId],
      });

      const rows = (result?.rows ?? []) as unknown as AppFileRow[];
      // User-scoped files belong to their uploader — a listing must not reveal
      // one visitor's files to another, even though both can reach the app.
      const visible = rows.filter(
        (row) =>
          !row.object_key.includes("/users/") ||
          (runtimeAuth.externalUserId &&
            row.object_key.includes(`/users/${runtimeAuth.externalUserId}/`)),
      );
      res.json({ files: visible });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private async resolveAccess(
    req: Request,
    appId?: string,
    enrichedAuth?: AppRuntimeRouteAuth,
    perf?: { accessCacheHit?: boolean },
  ): Promise<AppAccessContext | null> {
    const baseAuth = enrichedAuth ?? this.buildRuntimeAuth(req);
    if (!baseAuth) {
      return null;
    }

    const runtimeAuth =
      enrichedAuth ?? ((await enrichRuntimeAuthWithPaprApiKey(baseAuth)) ?? baseAuth);
    const accessStats = { cacheHit: false as boolean | undefined };
    const access = await validateCachedAccess(
      this.deps.publishResolver,
      runtimeAuth,
      accessStats,
    );
    if (perf && accessStats.cacheHit !== undefined) {
      perf.accessCacheHit = accessStats.cacheHit;
    }
    if (!access) return null;

    if (access.mode === "public_read" && !runtimeAuth.sessionToken) {
      const resolved = await resolvePublishedApp(
        runtimeAuth.namespaceId,
        runtimeAuth.slug,
        runtimeAuth.sessionToken,
      );
      if (
        resolved &&
        visibilityRequiresPaprLogin(resolved.visibility, resolved.requireSignIn)
      ) {
        return null;
      }
    }

    if (appId && access.appId !== appId) {
      return null;
    }

    if (await this.accessBlockedForAnonymousPerUserData(runtimeAuth)) {
      return null;
    }

    return access;
  }

  /**
   * Resolves auth + appId for /api/db/* and backend actions.
   * When the client omits appId (team/community installs must not hardcode UUIDs),
   * uses the published app's id from namespace/slug route context — same as
   * cloudDesktopPreviewProxy injects for desktop cloud-preview.
   */
  private async resolveDbAppContext(
    req: Request,
    res: Response,
    requestedAppId?: string,
    perf?: { accessCacheHit?: boolean },
  ): Promise<{
    runtimeAuth: AppRuntimeRouteAuth;
    access: AppAccessContext;
    appId: string;
  } | null> {
    const baseAuth = this.buildRuntimeAuth(req);
    if (!baseAuth) {
      res.status(403).json({ error: "Forbidden" });
      return null;
    }

    const runtimeAuth =
      (await enrichRuntimeAuthWithPaprApiKey(baseAuth)) ?? baseAuth;

    const trimmedAppId = requestedAppId?.trim() || undefined;
    const access = await this.resolveAccess(req, trimmedAppId, runtimeAuth, perf);
    if (!access) {
      await this.respondAccessDenied(req, res, runtimeAuth);
      return null;
    }

    const appId = trimmedAppId ?? access.appId;
    if (!appId) {
      res.status(400).json({ error: "appId could not be resolved from request context" });
      return null;
    }

    return { runtimeAuth, access, appId };
  }

  private async loadDataSources(
    runtimeAuth: AppRuntimeRouteAuth,
    requestedPath = "data-sources.json",
    stats?: { cacheHit?: boolean },
  ): Promise<AppDataSourcesFile> {
    return loadAppDataSourcesConfig(runtimeAuth, requestedPath, stats);
  }

  /** Fire-and-forget Turso client warm on app open (reads + legacy write paths). */
  private async warmLinkedTursoSources(
    runtimeAuth: AppRuntimeRouteAuth,
    access: AppAccessContext,
  ): Promise<void> {
    const config = await this.loadDataSources(runtimeAuth);
    if (config.sources.length === 0) {
      return;
    }
    await this.turso.warmLinkedSources({
      orgId: access.orgId,
      namespaceId: access.namespaceId,
      ...this.tursoDbRequest(access, runtimeAuth),
      runtimeAuth,
      config,
    });
  }

  private publishDbChangedForSource(
    config: AppDataSourcesFile,
    sourceId: string | undefined,
    appId: string,
    runtimeAuth: AppRuntimeRouteAuth,
  ): void {
    const target = resolveDbEventTarget(config, sourceId, appId);
    if (target.jobId || target.dbId) {
      publishDbChanged(target);
      void recordRuntimeTursoDbChanged(runtimeAuth, {
        ...(target.jobId ? { jobId: target.jobId } : {}),
        ...(target.dbId ? { dbId: target.dbId } : {}),
        source: "cloud_app_host",
      }).catch((err) => {
        console.warn(
          "[CloudAppHost] turso-db-changed record failed:",
          (err as Error).message.slice(0, 120),
        );
      });
    }
  }

  private async handleAccess(req: Request, res: Response): Promise<void> {
    try {
      const requestedAppId = req.query["appId"] as string | undefined;
      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const trimmedAppId = requestedAppId?.trim() || undefined;
      const access = await this.resolveAccess(req, trimmedAppId);
      const loggedIn = Boolean(this.auth.getSessionToken(req));
      const appId = trimmedAppId ?? access?.appId;
      const callerUserId = runtimeAuth.externalUserId;
      const email = loggedIn ? this.auth.getSessionEmail(req) : undefined;

      res.json(
        buildMiniAppAccessResponse(access, loggedIn, appId, {
          userId: callerUserId,
          email,
        }),
      );
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private async handleMembers(req: Request, res: Response): Promise<void> {
    try {
      const requestedAppId = req.query["appId"] as string | undefined;
      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const trimmedAppId = requestedAppId?.trim() || undefined;
      const access = await this.resolveAccess(req, trimmedAppId);
      const loggedIn = Boolean(this.auth.getSessionToken(req));
      const sessionToken = this.auth.getSessionToken(req);

      try {
        assertMiniAppMembersAccess(loggedIn, access);
      } catch (err) {
        if (err instanceof MiniAppMembersError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }

      if (!sessionToken) {
        res.status(401).json({ error: "Sign in with Papr to list workspace members." });
        return;
      }

      const namespaceId = access?.namespaceId ?? runtimeAuth.namespaceId;
      const result = await listMiniAppMembers({
        sessionToken,
        namespaceId,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof MiniAppMembersError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private async handleSchema(req: Request, res: Response): Promise<void> {
    try {
      const requestedAppId = req.query["appId"] as string | undefined;
      if (!this.enforceDbRateLimit(req, res, "read")) return;

      const ctx = await this.resolveDbAppContext(req, res, requestedAppId);
      if (!ctx) return;
      const { runtimeAuth, access } = ctx;

      if (!access.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth);
        return;
      }

      const config = await this.loadDataSources(runtimeAuth);
      const sources = await this.turso.schema({
        orgId: access.orgId,
        namespaceId: access.namespaceId,
        ...this.tursoDbRequest(access, runtimeAuth),
        runtimeAuth,
        config,
      });
      res.json({ sources });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private async handleQuery(req: Request, res: Response): Promise<void> {
    const queryStarted = performance.now();
    let accessMs = 0;
    let configMs = 0;
    let tursoQueryMs = 0;
    let cacheHit = false;
    const perf = { accessCacheHit: false, configCacheHit: false };

    try {
      const { appId: requestedAppId, sourceId, sql, params } = req.body as {
        appId?: string;
        sourceId?: string;
        sql?: string;
        params?: unknown[];
      };
      if (!sql) {
        res.status(400).json({ error: "sql is required" });
        return;
      }

      assertReadOnlySql(sql);

      if (!this.enforceDbRateLimit(req, res, "read")) return;

      const ctxStarted = performance.now();
      const ctx = await this.resolveDbAppContext(req, res, requestedAppId, perf);
      accessMs = performance.now() - ctxStarted;
      if (!ctx) return;
      const { runtimeAuth, access, appId } = ctx;

      if (!access.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth);
        return;
      }

      const configStarted = performance.now();
      const configStats = { cacheHit: false as boolean | undefined };
      const config = await this.loadDataSources(runtimeAuth, "data-sources.json", configStats);
      configMs = performance.now() - configStarted;
      if (configStats.cacheHit !== undefined) {
        perf.configCacheHit = configStats.cacheHit;
      }

      // Micro-cache: collapse polling apps and concurrent viewers into
      // ~1 Turso read per TTL window. Checked only after access control.
      const cacheKey = buildDbCacheKey({
        namespaceId: runtimeAuth.namespaceId,
        slug: runtimeAuth.slug,
        appId,
        sourceId,
        sql,
        params,
      });
      let cached = getCachedDbResult(cacheKey);
      if (cached !== undefined) {
        // Version gate: desktop boundary-sync pushes bump _papr_sync_meta on
        // Turso directly (they never call this host). A memoized single-row
        // version check bounds cache staleness for those writes to ~2.5s.
        const versionStarted = performance.now();
        const changed = await this.turso.hasRemoteChanged({
          orgId: access.orgId,
          namespaceId: access.namespaceId,
          ...this.tursoDbRequest(access, runtimeAuth),
          runtimeAuth,
          config,
          sourceId,
        });
        tursoQueryMs += performance.now() - versionStarted;
        if (changed) {
          invalidateDbCacheForApp(runtimeAuth.namespaceId, runtimeAuth.slug);
          this.publishDbChangedForSource(config, sourceId, appId, runtimeAuth);
          cached = undefined;
        } else {
          cacheHit = true;
          res.setHeader("X-Papr-Db-Cache", "hit");
          setCloudDbServerTiming(res, {
            access: accessMs,
            config: configMs,
            turso: tursoQueryMs,
            total: performance.now() - queryStarted,
            cache: "hit",
            ...cloudHostCacheTimingParts(perf),
          });
          res.json(cached);
          return;
        }
      }

      const queryExecStarted = performance.now();
      const result = await this.turso.query({
        orgId: access.orgId,
        namespaceId: access.namespaceId,
        ...this.tursoDbRequest(access, runtimeAuth),
        runtimeAuth,
        config,
        sourceId,
        sql,
        params,
      });
      tursoQueryMs += performance.now() - queryExecStarted;
      setCachedDbResult(cacheKey, result, {
        namespaceId: runtimeAuth.namespaceId,
        slug: runtimeAuth.slug,
      });
      setCloudDbServerTiming(res, {
        access: accessMs,
        config: configMs,
        turso: tursoQueryMs,
        total: performance.now() - queryStarted,
        cache: "miss",
        ...cloudHostCacheTimingParts(perf),
      });
      res.json(result);
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
    } finally {
      const totalMs = Math.round(performance.now() - queryStarted);
      if (process.env.CLOUD_DB_QUERY_TIMING !== "0") {
        console.log(
          `[CloudAppHost] /api/db/query timing accessMs=${Math.round(accessMs)} ` +
            `configMs=${Math.round(configMs)} tursoQueryMs=${Math.round(tursoQueryMs)} ` +
            `totalMs=${totalMs} cache=${cacheHit ? "hit" : "miss"}`,
        );
      }
    }
  }

  /**
   * Batch read endpoint — runs multiple read-only statements in one HTTP
   * round trip. Auth, access, and data-source config are resolved once for
   * the whole batch instead of per statement, and the browser pays one
   * network round trip instead of N. Statements execute sequentially;
   * per-statement errors are returned in-place without failing the batch.
   */
  private async handleBatchQuery(req: Request, res: Response): Promise<void> {
    const queryStarted = performance.now();
    let accessMs = 0;
    let configMs = 0;
    let tursoQueryMs = 0;

    try {
      const { appId: requestedAppId, statements } = req.body as {
        appId?: string;
        statements?: Array<{ sourceId?: string; sql?: string; params?: unknown[] }>;
      };
      if (!Array.isArray(statements) || statements.length === 0) {
        res.status(400).json({ error: "non-empty statements[] is required" });
        return;
      }
      if (statements.length > 25) {
        res.status(400).json({ error: "Batch limited to 25 statements" });
        return;
      }
      for (const stmt of statements) {
        if (!stmt?.sql) {
          res.status(400).json({ error: "Every statement requires sql" });
          return;
        }
        assertReadOnlySql(stmt.sql);
      }

      if (!this.enforceDbRateLimit(req, res, "read", statements.length)) return;

      const ctxStarted = performance.now();
      const ctx = await this.resolveDbAppContext(req, res, requestedAppId);
      accessMs = performance.now() - ctxStarted;
      if (!ctx) return;
      const { runtimeAuth, access, appId } = ctx;

      if (!access.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth);
        return;
      }

      const configStarted = performance.now();
      const config = await this.loadDataSources(runtimeAuth);
      configMs = performance.now() - configStarted;

      // Version gate (see handleQuery): one memoized check per distinct
      // source in the batch; any change busts the app's cache up front.
      const distinctSourceIds = [...new Set(statements.map((s) => s.sourceId))];
      const versionStarted = performance.now();
      for (const gateSourceId of distinctSourceIds) {
        const changed = await this.turso.hasRemoteChanged({
          orgId: access.orgId,
          namespaceId: access.namespaceId,
          ...this.tursoDbRequest(access, runtimeAuth),
          runtimeAuth,
          config,
          sourceId: gateSourceId,
        });
        if (changed) {
          invalidateDbCacheForApp(runtimeAuth.namespaceId, runtimeAuth.slug);
          this.publishDbChangedForSource(config, gateSourceId, appId, runtimeAuth);
          break;
        }
      }
      tursoQueryMs += performance.now() - versionStarted;

      const results: Array<Record<string, unknown>> = [];
      for (const stmt of statements) {
        try {
          const cacheKey = buildDbCacheKey({
            namespaceId: runtimeAuth.namespaceId,
            slug: runtimeAuth.slug,
            appId,
            sourceId: stmt.sourceId,
            sql: stmt.sql as string,
            params: stmt.params,
          });
          const cached = getCachedDbResult(cacheKey);
          if (cached !== undefined) {
            results.push({ ok: true, ...(cached as Record<string, unknown>) });
            continue;
          }
          const stmtStarted = performance.now();
          const result = await this.turso.query({
            orgId: access.orgId,
            namespaceId: access.namespaceId,
            ...this.tursoDbRequest(access, runtimeAuth),
            runtimeAuth,
            config,
            sourceId: stmt.sourceId,
            sql: stmt.sql as string,
            params: stmt.params,
          });
          tursoQueryMs += performance.now() - stmtStarted;
          setCachedDbResult(cacheKey, result, {
            namespaceId: runtimeAuth.namespaceId,
            slug: runtimeAuth.slug,
          });
          results.push({ ok: true, ...result });
        } catch (stmtErr) {
          results.push({ ok: false, error: (stmtErr as Error).message });
        }
      }
      res.json({ results });
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
    } finally {
      const totalMs = Math.round(performance.now() - queryStarted);
      if (process.env.CLOUD_DB_QUERY_TIMING !== "0") {
        console.log(
          `[CloudAppHost] /api/db/query-batch timing accessMs=${Math.round(accessMs)} ` +
            `configMs=${Math.round(configMs)} tursoQueryMs=${Math.round(tursoQueryMs)} ` +
            `totalMs=${totalMs}`,
        );
      }
    }
  }

  private async handleWrite(req: Request, res: Response): Promise<void> {
    const writeStarted = performance.now();
    let accessMs = 0;
    let configMs = 0;
    let tursoWriteMs = 0;

    try {
      const { appId: requestedAppId, sourceId, sql, params } = req.body as {
        appId?: string;
        sourceId?: string;
        sql?: string;
        params?: unknown[];
      };
      if (!sql) {
        res.status(400).json({ error: "sql is required" });
        return;
      }

      assertWriteSql(sql);

      if (!this.enforceDbRateLimit(req, res, "write")) return;

      const ctxStarted = performance.now();
      const ctx = await this.resolveDbAppContext(req, res, requestedAppId);
      accessMs = performance.now() - ctxStarted;
      if (!ctx) return;
      const { runtimeAuth, access, appId } = ctx;

      if (!access.canWrite) {
        if (!access.canRead) {
          await this.respondAccessDenied(req, res, runtimeAuth);
        } else {
          res.status(403).json({ error: "Write not allowed for this link" });
        }
        return;
      }

      const configStarted = performance.now();
      const config = await this.loadDataSources(runtimeAuth);
      configMs = performance.now() - configStarted;

      const writeStartedMs = performance.now();
      const result = await this.turso.write({
        orgId: access.orgId,
        namespaceId: access.namespaceId,
        ...this.tursoDbRequest(access, runtimeAuth),
        runtimeAuth,
        config,
        appId,
        sourceId,
        sql,
        params,
      });
      tursoWriteMs = performance.now() - writeStartedMs;

      // Bust read micro-cache and emit db-changed so UIs refresh
      invalidateDbCacheForApp(runtimeAuth.namespaceId, runtimeAuth.slug);
      this.publishDbChangedForSource(config, sourceId, appId, runtimeAuth);
      setCloudDbServerTiming(res, {
        access: accessMs,
        config: configMs,
        turso: tursoWriteMs,
        total: performance.now() - writeStarted,
      });
      res.json(result);
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
    } finally {
      const totalMs = Math.round(performance.now() - writeStarted);
      if (process.env.CLOUD_DB_WRITE_TIMING !== "0") {
        console.log(
          `[CloudAppHost] /api/db/write timing accessMs=${Math.round(accessMs)} ` +
            `configMs=${Math.round(configMs)} tursoWriteMs=${Math.round(tursoWriteMs)} ` +
            `totalMs=${totalMs}`,
        );
      }
    }
  }

  private async handleWriteBatch(req: Request, res: Response): Promise<void> {
    const writeStarted = performance.now();
    let accessMs = 0;
    let configMs = 0;
    let tursoWriteMs = 0;

    try {
      const { appId: requestedAppId, statements, atomic } = req.body as {
        appId?: string;
        statements?: Array<{ sourceId?: string; sql?: string; params?: unknown[] }>;
        atomic?: boolean;
      };
      if (!Array.isArray(statements) || statements.length === 0) {
        res.status(400).json({ error: "non-empty statements[] is required" });
        return;
      }
      if (statements.length > TursoDbAdapter.MAX_WRITE_BATCH) {
        res
          .status(400)
          .json({ error: `Batch limited to ${TursoDbAdapter.MAX_WRITE_BATCH} statements` });
        return;
      }
      for (const stmt of statements) {
        if (!stmt?.sql) {
          res.status(400).json({ error: "Every statement requires sql" });
          return;
        }
        assertWriteSql(stmt.sql);
      }

      if (!this.enforceDbRateLimit(req, res, "write", statements.length)) return;

      const ctxStarted = performance.now();
      const ctx = await this.resolveDbAppContext(req, res, requestedAppId);
      accessMs = performance.now() - ctxStarted;
      if (!ctx) return;
      const { runtimeAuth, access, appId } = ctx;

      if (!access.canWrite) {
        if (!access.canRead) {
          await this.respondAccessDenied(req, res, runtimeAuth);
        } else {
          res.status(403).json({ error: "Write not allowed for this link" });
        }
        return;
      }

      const configStarted = performance.now();
      const config = await this.loadDataSources(runtimeAuth);
      configMs = performance.now() - configStarted;

      const writeStartedMs = performance.now();
      const batchResult = await this.turso.writeBatch({
        orgId: access.orgId,
        namespaceId: access.namespaceId,
        ...this.tursoDbRequest(access, runtimeAuth),
        runtimeAuth,
        config,
        appId,
        atomic: atomic === true,
        statements: statements.map((stmt) => ({
          sourceId: stmt.sourceId,
          sql: stmt.sql as string,
          params: stmt.params,
        })),
      });
      tursoWriteMs = performance.now() - writeStartedMs;

      invalidateDbCacheForApp(runtimeAuth.namespaceId, runtimeAuth.slug);
      const distinctSourceIds = [
        ...new Set(statements.map((stmt) => stmt.sourceId)),
      ];
      for (const sourceId of distinctSourceIds) {
        this.publishDbChangedForSource(config, sourceId, appId, runtimeAuth);
      }
      setCloudDbServerTiming(res, {
        access: accessMs,
        config: configMs,
        turso: tursoWriteMs,
        total: performance.now() - writeStarted,
      });
      res.json({ atomic: atomic === true, ...batchResult });
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
    } finally {
      const totalMs = Math.round(performance.now() - writeStarted);
      if (process.env.CLOUD_DB_WRITE_TIMING !== "0") {
        console.log(
          `[CloudAppHost] /api/db/write-batch timing accessMs=${Math.round(accessMs)} ` +
            `configMs=${Math.round(configMs)} tursoWriteMs=${Math.round(tursoWriteMs)} ` +
            `totalMs=${totalMs}`,
        );
      }
    }
  }

  private async handleExec(req: Request, res: Response): Promise<void> {
    try {
      const { appId: requestedAppId, sourceId, sql } = req.body as {
        appId?: string;
        sourceId?: string;
        sql?: string;
      };
      if (!sql) {
        res.status(400).json({ error: "sql is required" });
        return;
      }

      assertExecSql(sql);

      if (!this.enforceDbRateLimit(req, res, "write")) return;

      const ctx = await this.resolveDbAppContext(req, res, requestedAppId);
      if (!ctx) return;
      const { runtimeAuth, access, appId } = ctx;

      if (!access.canWrite) {
        if (!access.canRead) {
          await this.respondAccessDenied(req, res, runtimeAuth);
        } else {
          res.status(403).json({ error: "Write not allowed for this link" });
        }
        return;
      }

      const config = await this.loadDataSources(runtimeAuth);
      const result = await this.turso.exec({
        orgId: access.orgId,
        namespaceId: access.namespaceId,
        ...this.tursoDbRequest(access, runtimeAuth),
        runtimeAuth,
        config,
        appId,
        sourceId,
        sql,
      });
      // Bust read micro-cache and emit db-changed so UIs refresh
      invalidateDbCacheForApp(runtimeAuth.namespaceId, runtimeAuth.slug);
      this.publishDbChangedForSource(config, sourceId, appId, runtimeAuth);
      res.json(result);
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
    }
  }

  private async handleClientKeys(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as { names?: string[] };
      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({
          error: "Forbidden — open the app in this browser tab first",
        });
        return;
      }

      const appId =
        typeof body === "object" &&
        body !== null &&
        "appId" in body &&
        typeof (body as { appId?: string }).appId === "string"
          ? (body as { appId: string }).appId
          : undefined;

      if (appId) {
        const access = await this.resolveAccess(req, appId);
        if (!access?.canRead) {
          await this.respondAccessDenied(req, res, runtimeAuth);
          return;
        }
      }

      const { resolveRuntimeVaultClientKeys } = await import(
        "./memoryRuntimeClient.js"
      );
      const result = await resolveRuntimeVaultClientKeys(runtimeAuth, {
        keyNames: body.names,
      });
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("(401)")) {
        res.status(401).json({ error: "authentication_required" });
        return;
      }
      if (message.includes("(403)")) {
        res.status(403).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  }

  private async handleBashRun(_req: Request, res: Response): Promise<void> {
    res.status(403).json({
      error: MINI_APP_BASH_DISABLED_CODE,
      message: MINI_APP_BASH_DISABLED_MESSAGE,
    });
  }

  private async handleBackendAction(req: Request, res: Response): Promise<void> {
    try {
      const action = req.params.action;
      if (!action || typeof action !== "string" || !action.trim()) {
        res.status(400).json({ error: "action name is required" });
        return;
      }

      const body = req.body as {
        appId?: string;
        params?: Record<string, string>;
        timeoutMs?: number;
      };

      const ctx = await this.resolveDbAppContext(req, res, body.appId);
      if (!ctx) return;
      const { runtimeAuth, access, appId } = ctx;

      if (!access.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth);
        return;
      }

      const credentialsOk = await this.credentials.ensureCredentialsForApi(
        req,
        res,
        runtimeAuth,
      );
      if (!credentialsOk) {
        return;
      }

      const backend = new CloudAppBackendService();
      const bypassFresh = shouldBypassRepoFileCache(req.headers);

      const loggedIn = Boolean(this.auth.getSessionToken(req));
      const callerEmail = loggedIn ? this.auth.getSessionEmail(req) : undefined;
      const callerIdentity = loggedIn
        ? {
            userId: runtimeAuth.externalUserId,
            ...(callerEmail ? { email: callerEmail } : {}),
          }
        : undefined;

      const result = await backend.runAction(runtimeAuth, {
        appId,
        action: action.trim(),
        params: body.params,
        timeoutMs: body.timeoutMs,
        bypassFresh,
        callerIdentity,
        loggedIn,
      });

      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("(404)")) {
        res.status(404).json({ error: message });
        return;
      }
      if (message.includes("(422)")) {
        res.status(422).json({ error: message });
        return;
      }
      if (message.includes("(408)")) {
        res.status(408).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  }

  private async handleJobsList(req: Request, res: Response): Promise<void> {
    try {
      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden — open the app in this browser tab first" });
        return;
      }

      const access = await this.resolveAccess(req);
      if (!access?.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth);
        return;
      }

      const { jobs, count } = await listRuntimeJobs(runtimeAuth);
      res.json({ jobs, count });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private async handleJobStatus(req: Request, res: Response): Promise<void> {
    try {
      const jobId = req.params.jobId;
      if (!jobId || typeof jobId !== "string" || !jobId.trim()) {
        res.status(400).json({ error: "jobId is required" });
        return;
      }

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden — open the app in this browser tab first" });
        return;
      }

      const job = await getRuntimeJobStatus(runtimeAuth, jobId);
      if (!job) {
        res.status(404).json({ error: `Job not found: ${jobId}` });
        return;
      }
      res.json(job);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private publishRuntimeJobResult(result: {
    jobId: string;
    name?: string;
    status: string;
    error?: string | null;
    lastOutput?: string;
    stdout?: string;
  }): void {
    publishJobStatusChanged({
      jobId: result.jobId,
      name: result.name,
      status: result.status,
      error: result.error ?? undefined,
      lastOutput: result.lastOutput,
    });
    publishJobOutputProgress(result.jobId, result.stdout);
  }

  /** Memory server rejects job-run when only a share token is present (no Papr session). */
  private jobRunRequiresSignIn(runtimeAuth: AppRuntimeRouteAuth): boolean {
    return Boolean(
      runtimeAuth.shareToken &&
        !runtimeAuth.sessionToken &&
        !runtimeAuth.paprApiKey,
    );
  }

  private respondJobRunSignInRequired(req: Request, res: Response): void {
    const runtimeAuth = this.buildRuntimeAuth(req);
    const returnTo = resolveCloudAuthReturnToFromRequest(req, runtimeAuth
      ? { namespaceId: runtimeAuth.namespaceId, slug: runtimeAuth.slug }
      : undefined);
    res.status(403).json({
      error:
        "Sign in to Papr to run agent jobs from this app. Invite links can use the app UI and backend actions, but AI jobs require a Papr account.",
      code: "job_run_sign_in_required",
      loginUrl: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    });
  }

  private runRuntimeJobInBackground(
    runtimeAuth: AppRuntimeRouteAuth,
    input: {
      jobId: string;
      params?: Record<string, string>;
      timeoutMs?: number;
    },
  ): void {
    void runRuntimeJob(runtimeAuth, {
      jobId: input.jobId,
      params: input.params,
      timeoutMs: input.timeoutMs,
      tier: "sandbox",
    })
      .then((result) => {
        this.publishRuntimeJobResult(result);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[CloudAppHost] /api/jobs/run background error for ${input.jobId}:`,
          message,
        );
        const needsSignIn =
          message.includes("Sign in required") ||
          message.includes("not available on share links");
        publishJobStatusChanged({
          jobId: input.jobId,
          status: "failed",
          error: needsSignIn
            ? "Sign in to Papr to run agent jobs from this app."
            : message,
        });
      });
  }

  private async handleJobRun(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as {
        jobId?: string;
        wait?: boolean;
        params?: Record<string, string>;
        timeoutMs?: number;
      };
      if (!body.jobId) {
        res.status(400).json({ error: "jobId is required" });
        return;
      }

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden — open the app in this browser tab first" });
        return;
      }

      const access = await this.resolveAccess(req);
      if (!access?.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth);
        return;
      }

      const credentialsOk = await this.credentials.ensureCredentialsForApi(
        req,
        res,
        runtimeAuth,
      );
      if (!credentialsOk) {
        return;
      }

      const jobInput = {
        jobId: body.jobId,
        params: mergeVerifiedCallerJobParams(
          body.params,
          Boolean(this.auth.getSessionToken(req)),
          {
            userId: runtimeAuth.externalUserId,
            email: this.auth.getSessionEmail(req),
          },
        ),
        timeoutMs: body.timeoutMs,
      };

      // Fail synchronously so papr-auth-guard can show login (fire-and-forget
      // would return 200 before memory server rejects share-link-only callers).
      if (this.jobRunRequiresSignIn(runtimeAuth)) {
        this.respondJobRunSignInRequired(req, res);
        return;
      }

      // Default: fire-and-forget (matches desktop gateway). Agent jobs can run
      // many minutes — Cloud Run request timeout is 60s, so blocking here 504s.
      if (body.wait !== true) {
        this.runRuntimeJobInBackground(runtimeAuth, jobInput);
        res.json({ jobId: body.jobId, status: "running" });
        return;
      }

      const result = await runRuntimeJob(runtimeAuth, {
        ...jobInput,
        tier: "sandbox",
      });

      this.publishRuntimeJobResult(result);

      res.json({
        jobId: result.jobId,
        status: result.status,
        exitCode: result.exitCode,
        error: result.error,
        lastOutput: result.lastOutput,
        backend: result.backend,
        tier: result.tier,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("(422)")) {
        res.status(422).json({ error: message });
        return;
      }
      if (message.includes("(403)")) {
        const needsSignInForJobs =
          message.includes("Sign in required") ||
          message.includes("not available on share links");
        if (needsSignInForJobs) {
          this.respondJobRunSignInRequired(req, res);
          return;
        }
        res.status(403).json({ error: message });
        return;
      }
      if (message.includes("(408)")) {
        res.status(408).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  }

  private async handleInternalAppRepoCommitted(
    req: Request,
    res: Response,
  ): Promise<void> {
    if (!this.verifyCloudAppHostInternalKey(req, res)) {
      return;
    }

    const { parseAppRepoCommittedPayload } = await import(
      "../syncV3/appRepoCommittedInbound.js"
    );
    const event = parseAppRepoCommittedPayload(req.body);
    if (!event) {
      res.status(400).json({ error: "Invalid app-repo-committed payload" });
      return;
    }

    try {
      const { receiveAppRepoCommittedEvent } = await import(
        "../syncV3/appRepoRevisionSubscriber.js"
      );
      await receiveAppRepoCommittedEvent(event);

      const slug = await this.resolvePublishSlugForApp(event.appId);
      if (slug) {
        invalidateRepoCacheForPublishedApp(event.namespaceId, slug);
        res.json({ ok: true, appId: event.appId, cacheInvalidated: true });
        return;
      }

      invalidateRepoCacheForNamespace(event.namespaceId);
      res.json({ ok: true, appId: event.appId, cacheInvalidated: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private async resolvePublishSlugForApp(appId: string): Promise<string | null> {
    try {
      const resp = await runtimeFetch(
        `${getMemoryServerBaseUrl()}/v1/cloud/apps/publish/${encodeURIComponent(appId)}`,
        {
          method: "GET",
          headers: {
            "X-Cloud-App-Host-Key": getCloudAppHostKey(),
          },
        },
      );
      if (!resp.ok) {
        return null;
      }
      const payload = (await resp.json()) as { slug?: string; enabled?: boolean };
      if (payload.enabled === false) {
        return null;
      }
      const slug = payload.slug?.trim();
      return slug && slug.length > 0 ? slug : null;
    } catch {
      return null;
    }
  }

  private async handleInternalAppRevisionUpdated(
    req: Request,
    res: Response,
  ): Promise<void> {
    if (!this.verifyCloudAppHostInternalKey(req, res)) {
      return;
    }

    const body = req.body as { namespaceId?: string; slug?: string };
    const namespaceId = body.namespaceId?.trim();
    const slug = body.slug?.trim();
    if (!namespaceId || !slug) {
      res.status(400).json({ error: "namespaceId and slug are required" });
      return;
    }

    invalidateRepoCacheForPublishedApp(namespaceId, slug);
    res.json({ ok: true, cacheInvalidated: true });
  }

  private verifyCloudAppHostInternalKey(req: Request, res: Response): boolean {
    const configuredKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();
    const providedKey = String(req.headers["x-cloud-app-host-key"] ?? "").trim();
    if (!configuredKey || providedKey !== configuredKey) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  private handleInternalDbChanged(req: Request, res: Response): void {
    if (!this.verifyCloudAppHostInternalKey(req, res)) {
      return;
    }

    const body = req.body as {
      jobId?: string;
      dbId?: string;
      tables?: string[];
    };
    const jobId = body.jobId?.trim();
    const dbId = body.dbId?.trim();
    if (!jobId && !dbId) {
      res.status(400).json({ error: "jobId or dbId is required" });
      return;
    }

    publishDbChanged({
      ...(jobId ? { jobId } : {}),
      ...(dbId ? { dbId } : {}),
      tables: Array.isArray(body.tables) ? body.tables : [],
    });
    res.json({ ok: true });
  }

  private async handleAppRevision(req: Request, res: Response): Promise<void> {
    try {
      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const access = await this.resolveAccess(req);
      if (!access?.canRead) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const bypassFresh = shouldBypassRepoFileCache(req.headers);
      const revision = await resolvePublishedAppRevision(runtimeAuth, {
        bypassFresh,
      });
      if (!revision) {
        res.status(404).json({ error: "Revision unavailable" });
        return;
      }

      res.setHeader("Cache-Control", "no-cache, must-revalidate");
      const metaFile = await fetchCachedRuntimeRepoFile(
        runtimeAuth,
        PAPR_APP_META_RELATIVE_PATH,
        { bypassFresh },
      );
      const meta = metaFile
        ? readCloudAppMetaFromContent(metaFile.content)
        : null;
      res.json({
        revision,
        requiredSchemaVersion: normalizeRequiredSchemaVersion(
          meta?.requiredSchemaVersion,
        ),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private async handlePublishedAppFile(
    req: Request,
    res: Response,
    requestedPath: string,
  ): Promise<void> {
    try {
      if (this.maybeExchangeShareToken(req, res)) {
        return;
      }

      if (this.maybeTrailingSlashRedirect(req, res, requestedPath)) {
        return;
      }

      if (requestedPath.includes("..")) {
        res.status(400).send("Invalid app path");
        return;
      }

      if (
        requestedPath === "backend" ||
        requestedPath.startsWith("backend/")
      ) {
        res.status(404).send("Not found");
        return;
      }

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).send("Forbidden");
        return;
      }

      const access = await this.resolveAccess(req);
      if (requestedPath === "opengraph-icon") {
        await this.handleOpenGraphIcon(req, res, runtimeAuth, access?.canRead === true);
        return;
      }

      if (!access?.canRead) {
        if (requestedPath === "index.html") {
          await this.sendShareGatePreview(req, res, runtimeAuth);
          return;
        }
        await this.respondAccessDenied(req, res, runtimeAuth, { html: true });
        return;
      }

      if (requestedPath === "credentials/setup") {
        await this.credentials.serveCredentialSetupPage(req, res, runtimeAuth);
        return;
      }

      const credentialsOk = await this.credentials.ensureCredentialsForApp(
        req,
        res,
        runtimeAuth,
        requestedPath,
        true,
      );
      if (!credentialsOk) {
        return;
      }

      await this.sendAppFile(req, res, runtimeAuth, requestedPath, access);
    } catch (err) {
      res.status(500).send((err as Error).message);
    }
  }

  private async sendShareGatePreview(
    req: Request,
    res: Response,
    runtimeAuth: AppRuntimeRouteAuth,
  ): Promise<void> {
    const publicBaseUrl = getCloudAppPublicBaseUrl(req);
    const hasSession = Boolean(runtimeAuth.sessionToken);
    // Prefer publish-catalog branding for unsigned visitors; repo metadata when signed in.
    const canReadRepo = hasSession;
    const published = await resolvePublishedApp(
      runtimeAuth.namespaceId,
      runtimeAuth.slug,
      runtimeAuth.sessionToken,
    );
    const meta = await resolveCloudAppPreviewMeta({
      runtimeAuth,
      publicBaseUrl,
      canReadRepo,
      publishedApp: published,
    });
    const iconSvg = await resolvePreviewIconSvg(runtimeAuth, canReadRepo, published);
    const returnTo = resolveCloudAuthReturnToFromRequest(req, {
      namespaceId: runtimeAuth.namespaceId,
      slug: runtimeAuth.slug,
    });
    const loginUrl = buildCloudAuthLoginUrl(returnTo, "login");
    const signupUrl = buildCloudAuthLoginUrl(returnTo, "signup");
    const presentation = resolveShareGatePresentation({
      hasSession,
      hasShareToken: Boolean(runtimeAuth.shareToken),
      visibility: published?.visibility,
    });
    res
      .status(200)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(
        buildShareGateLandingHtml(meta, loginUrl, presentation, iconSvg, signupUrl),
      );
  }

  private async handleOpenGraphIcon(
    _req: Request,
    res: Response,
    runtimeAuth: AppRuntimeRouteAuth,
    canReadRepo: boolean,
  ): Promise<void> {
    const svg = await resolvePreviewIconSvg(runtimeAuth, canReadRepo);
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(svg);
  }

  private async sendAppFile(
    req: Request,
    res: Response,
    runtimeAuth: AppRuntimeRouteAuth,
    requestedPath: string,
    access: AppAccessContext | null = null,
  ): Promise<void> {
    // Browser reload (F5 / hard reload) bypasses SWR so synced changes appear immediately.
    const bypassFresh = shouldBypassRepoFileCache(req.headers);
    const file = await fetchCachedRuntimeRepoFile(runtimeAuth, requestedPath, {
      bypassFresh,
    });
    if (!file) {
      res.status(404).send("Not found");
      return;
    }

    const ext = path.extname(requestedPath).toLowerCase();
    let content = file.content;
    let contentType = getMiniAppContentType(ext) || file.contentType;
    let transpiled = false;

    if (ext === ".html" && requestedPath === "index.html") {
      const revision = await resolvePublishedAppRevision(runtimeAuth, {
        bypassFresh,
      });
      const [distBundle, distCss] = await Promise.all([
        fetchCachedRuntimeRepoFile(runtimeAuth, "dist/app.js", { bypassFresh }),
        fetchCachedRuntimeRepoFile(runtimeAuth, "dist/app.css", { bypassFresh }),
      ]);
      if (distBundle) {
        const { rewriteHtmlForBundledDist, appendDistAssetCacheBusters } =
          await import("../../utils/miniAppBuild.js");
        const { createHash } = await import("node:crypto");
        content = rewriteHtmlForBundledDist(content, {
          hasDistCss: distCss !== null,
        });
        const appJsHash = createHash("sha256")
          .update(distBundle.content)
          .digest("hex")
          .slice(0, 16);
        content = appendDistAssetCacheBusters(content, {
          appJs: appJsHash,
          ...(distCss
            ? {
                appCss: createHash("sha256")
                  .update(distCss.content)
                  .digest("hex")
                  .slice(0, 16),
              }
            : {}),
        });

        if (revision) {
          content = injectPaprAppRevisionMeta(content, revision);
        }
      }

      if (access) {
        try {
          const config = await this.loadDataSources(runtimeAuth);
          await evaluateCloudAppSchemaGate({
            turso: this.turso,
            runtimeAuth,
            orgId: access.orgId,
            namespaceId: access.namespaceId,
            userId: access.userId,
            callerUserId: runtimeAuth.externalUserId,
            config,
            currentRevision: revision ?? null,
          });
        } catch (err) {
          console.warn(
            "[CloudAppHost] schema gate skipped:",
            (err as Error).message.slice(0, 120),
          );
        }
      }

      const publicBaseUrl = getCloudAppPublicBaseUrl(req);
      const previewMeta = await resolveCloudAppPreviewMeta({
        runtimeAuth,
        publicBaseUrl,
        canReadRepo: true,
      });
      content = injectCloudAppPreviewIntoHtml(
        injectPublishedAppBaseHref(
          injectPaprCloudContextMeta(
            content,
            runtimeAuth.namespaceId,
            runtimeAuth.slug,
          ),
          publishedAppBaseHref(runtimeAuth.namespaceId, runtimeAuth.slug),
        ),
        previewMeta,
        runtimeAuth.namespaceId,
        runtimeAuth.slug,
      );

      // Platform scripts: native dialog shim (must run before app code), auth, version check.
      const platformScripts = [
        `<script src="/__papr__/papr-native-dialog-shim.js"></script>`,
        `<script src="/__papr__/papr-auth-guard.js" defer></script>`,
        `<script src="/__papr__/papr-version-check.js" defer></script>`,
      ].join("\n");
      if (content.includes("</head>")) {
        content = content.replace("</head>", `${platformScripts}\n</head>`);
      } else {
        content = platformScripts + "\n" + content;
      }
    }

    const isDistAsset = requestedPath.startsWith("dist/");
    if (!isDistAsset && isMiniAppTypeScriptFile(requestedPath)) {
      const transpileResult = await getCachedTranspiledTypeScript(
        runtimeAuth,
        requestedPath,
        content,
      );
      if (!transpileResult.success) {
        const location =
          transpileResult.line !== undefined ? ` at line ${transpileResult.line}` : "";
        res
          .status(500)
          .send(
            `TypeScript compilation error${location}: ${transpileResult.message ?? "Unknown error"}`,
          );
        return;
      }
      content = transpileResult.code ?? content;
      contentType = "text/javascript; charset=utf-8";
      transpiled = true;
    }

    const cacheControl = cacheControlForAppAsset(requestedPath, { transpiled });
    if (cacheControl) {
      res.setHeader("Cache-Control", cacheControl);
    }

    res.setHeader("Content-Type", contentType);
    res.send(content);
  }

  private async handleAppFile(req: Request, res: Response): Promise<void> {
    try {
      const appId = req.params[0];
      const wildcard = req.params[1];
      const requestedPath =
        typeof wildcard === "string" && wildcard.length > 0
          ? wildcard
          : "index.html";

      if (requestedPath.includes("..")) {
        res.status(400).send("Invalid app path");
        return;
      }

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).send("Forbidden");
        return;
      }

      const access = await this.resolveAccess(req, appId);
      if (!access?.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth, { html: true });
        return;
      }

      void this.warmLinkedTursoSources(runtimeAuth, access).catch(() => {});

      await this.sendAppFile(req, res, runtimeAuth, requestedPath, access);
    } catch (err) {
      res.status(500).send((err as Error).message);
    }
  }
}
