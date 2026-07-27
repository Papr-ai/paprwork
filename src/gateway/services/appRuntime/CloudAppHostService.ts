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
import { parseDataSourcesFile, type AppDataSourcesFile } from "../appDataSources.js";
import { resolveDbEventTarget } from "../../utils/resolveDbEventTarget.js";
import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import {
  fetchRuntimeDbToken,
  listRuntimeJobs,
  runRuntimeJob,
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
  validateCachedAccess,
} from "./cloudAppHostCache.js";
import { shouldBypassRepoFileCache } from "./cloudAppHostRequestCache.js";
import {
  cloudContextCookieHeaders,
  isReservedCloudPathSegment,
  resolveCloudRouteContext,
} from "./cloudAppHostContext.js";
import { CloudAppHostAuthService } from "./CloudAppHostAuthService.js";
import { CloudAppHostCredentialService } from "./CloudAppHostCredentialService.js";
import {
  buildShareTokenCookie,
  readShareTokenFromCookie,
  sanitizeReturnToPath,
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
  buildDbCacheKey,
  checkDbRateLimit,
  dbRateLimitKey,
  getCachedDbResult,
  invalidateDbCacheForApp,
  setCachedDbResult,
} from "./dbRequestGuard.js";
import { isMiniAppTypeScriptFile } from "../../utils/miniAppTranspile.js";
import { isLinkPreviewCrawler } from "../../../core/utils/cloudAppPreview.js";
import {
  buildShareGateLandingHtml,
  resolveShareGatePresentation,
  getCloudAppPublicBaseUrl,
  injectCloudAppPreviewIntoHtml,
  resolveCloudAppPreviewMeta,
  resolvePreviewIconSvg,
} from "./CloudAppPreviewService.js";
import {
  formatPublishedAppRevision,
  injectPaprAppRevisionMeta,
  resolvePublishedAppRevision,
} from "./publishedAppRevision.js";
import {
  CLOUD_REPO_HEAD_RELATIVE_PATH,
  parseCloudRepoHeadContent,
} from "../cloudSync/cloudRepoHeadMarker.js";
import { getAppRevisionHub } from "./AppRevisionHub.js";
import { registerAppRevisionSseRoutes } from "./registerAppRevisionSse.js";

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

    const res = await fetch(`${getMemoryServerBaseUrl()}/v1/cloud/apps/access/validate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        namespaceId: input.namespaceId,
        slug: input.slug,
        paprApiKey: input.paprApiKey,
        shareToken: input.shareToken,
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
    registerAppRevisionSseRoutes(app, getAppRevisionHub());
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
          const { jobs } = await listRuntimeJobs(runtimeAuth);
          const job = jobs.find((entry) => entry.id === jobId);
          if (!job) {
            return null;
          }
          return {
            jobId: job.id,
            name: job.name,
            status: job.status ?? "unknown",
            completedAt: job.completedAt,
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

    app.get("/api/db/schema", (req, res) => this.handleSchema(req, res));
    app.post("/api/db/query", (req, res) => this.handleQuery(req, res));
    app.post("/api/db/batch", (req, res) => this.handleBatchQuery(req, res));
    app.post("/api/db/write", (req, res) => this.handleWrite(req, res));
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
    };
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

    const returnTo = sanitizeReturnToPath(req.originalUrl.split("?")[0] ?? req.originalUrl);
    const loginUrl = `/auth/login?returnTo=${encodeURIComponent(returnTo)}&start=1`;

    if (!resolved || visibilityRequiresPaprLogin(resolved.visibility)) {
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

  private async resolveAccess(
    req: Request,
    appId?: string,
  ): Promise<AppAccessContext | null> {
    const runtimeAuth = this.buildRuntimeAuth(req);
    if (!runtimeAuth) {
      return null;
    }

    const access = await validateCachedAccess(this.deps.publishResolver, runtimeAuth);
    if (!access) return null;
    if (appId && access.appId !== appId) {
      return null;
    }
    return access;
  }

  private async loadDataSources(
    runtimeAuth: AppRuntimeRouteAuth,
    requestedPath = "data-sources.json",
  ): Promise<ReturnType<typeof parseDataSourcesFile>> {
    const file = await fetchCachedRuntimeRepoFile(runtimeAuth, requestedPath);
    if (!file?.content) {
      return { sources: [] };
    }
    return parseDataSourcesFile(file.content);
  }

  private publishDbChangedForSource(
    config: AppDataSourcesFile,
    sourceId: string | undefined,
    appId: string,
  ): void {
    const target = resolveDbEventTarget(config, sourceId, appId);
    if (target.jobId || target.dbId) {
      publishDbChanged(target);
    }
  }

  private async handleSchema(req: Request, res: Response): Promise<void> {
    try {
      const appId = req.query["appId"] as string | undefined;
      if (!appId) {
        res.status(400).json({ error: "appId query param required" });
        return;
      }
      if (!this.enforceDbRateLimit(req, res, "read")) return;

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const access = await this.resolveAccess(req, appId);
      if (!access?.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth);
        return;
      }

      const config = await this.loadDataSources(runtimeAuth);
      const sources = await this.turso.schema({
        orgId: access.orgId,
        namespaceId: access.namespaceId,
        userId: access.userId,
        runtimeAuth,
        config,
      });
      res.json({ sources });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }

  private async handleQuery(req: Request, res: Response): Promise<void> {
    try {
      const { appId, sourceId, sql, params } = req.body as {
        appId?: string;
        sourceId?: string;
        sql?: string;
        params?: unknown[];
      };
      if (!appId || !sql) {
        res.status(400).json({ error: "appId and sql are required" });
        return;
      }

      assertReadOnlySql(sql);

      if (!this.enforceDbRateLimit(req, res, "read")) return;

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const access = await this.resolveAccess(req, appId);
      if (!access?.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth);
        return;
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
        const gateConfig = await this.loadDataSources(runtimeAuth);
        const changed = await this.turso.hasRemoteChanged({
          orgId: access.orgId,
          namespaceId: access.namespaceId,
          userId: access.userId,
          runtimeAuth,
          config: gateConfig,
          sourceId,
        });
        if (changed) {
          invalidateDbCacheForApp(runtimeAuth.namespaceId, runtimeAuth.slug);
          this.publishDbChangedForSource(gateConfig, sourceId, appId);
          cached = undefined;
        } else {
          res.setHeader("X-Papr-Db-Cache", "hit");
          res.json(cached);
          return;
        }
      }

      const config = await this.loadDataSources(runtimeAuth);
      const result = await this.turso.query({
        orgId: access.orgId,
        namespaceId: access.namespaceId,
        userId: access.userId,
        runtimeAuth,
        config,
        sourceId,
        sql,
        params,
      });
      setCachedDbResult(cacheKey, result, {
        namespaceId: runtimeAuth.namespaceId,
        slug: runtimeAuth.slug,
      });
      res.json(result);
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
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
    try {
      const { appId, statements } = req.body as {
        appId?: string;
        statements?: Array<{ sourceId?: string; sql?: string; params?: unknown[] }>;
      };
      if (!appId || !Array.isArray(statements) || statements.length === 0) {
        res.status(400).json({ error: "appId and non-empty statements[] are required" });
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

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const access = await this.resolveAccess(req, appId);
      if (!access?.canRead) {
        await this.respondAccessDenied(req, res, runtimeAuth);
        return;
      }

      const config = await this.loadDataSources(runtimeAuth);

      // Version gate (see handleQuery): one memoized check per distinct
      // source in the batch; any change busts the app's cache up front.
      const distinctSourceIds = [...new Set(statements.map((s) => s.sourceId))];
      for (const gateSourceId of distinctSourceIds) {
        const changed = await this.turso.hasRemoteChanged({
          orgId: access.orgId,
          namespaceId: access.namespaceId,
          userId: access.userId,
          runtimeAuth,
          config,
          sourceId: gateSourceId,
        });
        if (changed) {
          invalidateDbCacheForApp(runtimeAuth.namespaceId, runtimeAuth.slug);
          this.publishDbChangedForSource(config, gateSourceId, appId);
          break;
        }
      }

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
          const result = await this.turso.query({
            orgId: access.orgId,
            namespaceId: access.namespaceId,
            userId: access.userId,
            runtimeAuth,
            config,
            sourceId: stmt.sourceId,
            sql: stmt.sql as string,
            params: stmt.params,
          });
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
    }
  }

  private async handleWrite(req: Request, res: Response): Promise<void> {
    try {
      const { appId, sourceId, sql, params } = req.body as {
        appId?: string;
        sourceId?: string;
        sql?: string;
        params?: unknown[];
      };
      if (!appId || !sql) {
        res.status(400).json({ error: "appId and sql are required" });
        return;
      }

      assertWriteSql(sql);

      if (!this.enforceDbRateLimit(req, res, "write")) return;

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const access = await this.resolveAccess(req, appId);
      if (!access?.canWrite) {
        if (!access?.canRead) {
          await this.respondAccessDenied(req, res, runtimeAuth);
        } else {
          res.status(403).json({ error: "Write not allowed for this link" });
        }
        return;
      }

      const config = await this.loadDataSources(runtimeAuth);
      const result = await this.turso.write({
        orgId: access.orgId,
        namespaceId: access.namespaceId,
        userId: access.userId,
        runtimeAuth,
        config,
        sourceId,
        sql,
        params,
      });
      // Bust read micro-cache and emit db-changed so UIs refresh
      invalidateDbCacheForApp(runtimeAuth.namespaceId, runtimeAuth.slug);
      this.publishDbChangedForSource(config, sourceId, appId);
      res.json(result);
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
    }
  }

  private async handleExec(req: Request, res: Response): Promise<void> {
    try {
      const { appId, sourceId, sql } = req.body as {
        appId?: string;
        sourceId?: string;
        sql?: string;
      };
      if (!appId || !sql) {
        res.status(400).json({ error: "appId and sql are required" });
        return;
      }

      assertExecSql(sql);

      if (!this.enforceDbRateLimit(req, res, "write")) return;

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const access = await this.resolveAccess(req, appId);
      if (!access?.canWrite) {
        if (!access?.canRead) {
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
        userId: access.userId,
        runtimeAuth,
        config,
        sourceId,
        sql,
      });
      // Bust read micro-cache and emit db-changed so UIs refresh
      invalidateDbCacheForApp(runtimeAuth.namespaceId, runtimeAuth.slug);
      this.publishDbChangedForSource(config, sourceId, appId);
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
      if (!body.appId || typeof body.appId !== "string") {
        res.status(400).json({ error: "appId is required" });
        return;
      }

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden — open the app in this browser tab first" });
        return;
      }

      const access = await this.resolveAccess(req, body.appId);
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

      const backend = new CloudAppBackendService();
      const bypassFresh = shouldBypassRepoFileCache(req.headers);

      const result = await backend.runAction(runtimeAuth, {
        appId: body.appId,
        action: action.trim(),
        params: body.params,
        timeoutMs: body.timeoutMs,
        bypassFresh,
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
      if (!jobId) {
        res.status(400).json({ error: "jobId is required" });
        return;
      }

      const runtimeAuth = this.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden — open the app in this browser tab first" });
        return;
      }

      const { jobs } = await listRuntimeJobs(runtimeAuth);
      const job = jobs.find((entry) => entry.id === jobId);
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
    const returnTo = sanitizeReturnToPath(
      req.originalUrl.split("?")[0] ?? req.originalUrl,
    );
    res.status(403).json({
      error:
        "Sign in to Papr to run agent jobs from this app. Invite links can use the app UI and backend actions, but AI jobs require a Papr account.",
      code: "job_run_sign_in_required",
      loginUrl: `/auth/login?returnTo=${encodeURIComponent(returnTo)}&start=1`,
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
        params: body.params,
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

  private async handleInternalAppRevisionUpdated(
    req: Request,
    res: Response,
  ): Promise<void> {
    const configuredKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();
    const providedKey = String(req.headers["x-cloud-app-host-key"] ?? "").trim();
    if (!configuredKey || providedKey !== configuredKey) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const body = req.body as { namespaceId?: string; slug?: string };
    const namespaceId = body.namespaceId?.trim();
    const slug = body.slug?.trim();
    if (!namespaceId || !slug) {
      res.status(400).json({ error: "namespaceId and slug are required" });
      return;
    }

    try {
      invalidateRepoCacheForPublishedApp(namespaceId, slug);

      const runtimeAuth: AppRuntimeRouteAuth = { namespaceId, slug };
      const revision = await resolvePublishedAppRevision(runtimeAuth, {
        bypassFresh: true,
      });
      if (revision) {
        getAppRevisionHub().publish({ namespaceId, slug, revision });
      }

      res.json({ ok: true, revision: revision ?? null });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
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
      res.json({ revision });
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

      await this.sendAppFile(req, res, runtimeAuth, requestedPath);
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
    const access = await this.resolveAccess(req);
    const meta = await resolveCloudAppPreviewMeta({
      runtimeAuth,
      publicBaseUrl,
      canReadRepo: access?.canRead === true,
    });
    const returnTo = sanitizeReturnToPath(req.originalUrl.split("?")[0] ?? req.originalUrl);
    const loginUrl = `/auth/login?returnTo=${encodeURIComponent(returnTo)}&start=1`;
    const hasSession = Boolean(runtimeAuth.sessionToken);
    const published = await resolvePublishedApp(
      runtimeAuth.namespaceId,
      runtimeAuth.slug,
      runtimeAuth.sessionToken,
    );
    const presentation = resolveShareGatePresentation({
      hasSession,
      hasShareToken: Boolean(runtimeAuth.shareToken),
      visibility: published?.visibility,
    });
    res
      .status(200)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(buildShareGateLandingHtml(meta, loginUrl, presentation));
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
      const distBundle = await fetchCachedRuntimeRepoFile(
        runtimeAuth,
        "dist/app.js",
        { bypassFresh },
      );
      if (distBundle) {
        const distCss = await fetchCachedRuntimeRepoFile(
          runtimeAuth,
          "dist/app.css",
          { bypassFresh },
        );
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

        const repoHeadFile = await fetchCachedRuntimeRepoFile(
          runtimeAuth,
          CLOUD_REPO_HEAD_RELATIVE_PATH,
          { bypassFresh },
        );
        const repoHead = repoHeadFile
          ? parseCloudRepoHeadContent(repoHeadFile.content)
          : "0";
        const revision = formatPublishedAppRevision(repoHead, distBundle.content);
        if (revision) {
          content = injectPaprAppRevisionMeta(content, revision);
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
          content,
          publishedAppBaseHref(runtimeAuth.namespaceId, runtimeAuth.slug),
        ),
        previewMeta,
        runtimeAuth.namespaceId,
        runtimeAuth.slug,
      );

      // Platform scripts: auth guard + auto-reload when synced bundle changes.
      const platformScripts = [
        `<script src="/__papr__/papr-auth-guard.js" defer></script>`,
        `<script src="/__papr__/papr-app-refresh.js" defer></script>`,
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

      await this.sendAppFile(req, res, runtimeAuth, requestedPath);
    } catch (err) {
      res.status(500).send((err as Error).message);
    }
  }
}
