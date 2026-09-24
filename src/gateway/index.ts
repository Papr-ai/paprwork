import { recordGatewayHealthEvent } from "./services/gatewayHealthEvents.js";
/**
 * Gateway Process Entry Point
 *
 * Pure Node.js server (no Electron dependencies)
 * - WebSocket server for client communication
 * - HTTP server for UI assets
 * - Agent and Chat services
 *
 * API Keys:
 * - Passed from Electron via environment variables
 * - Electron fetches them from macOS Keychain
 * - No .env files in production (packaged app)
 */

// Load environment for development. `.env.local` is read before `.env`
// because dotenv never overwrites an already-set variable, so the first file
// to define a key wins. Both are gitignored and absent in packaged/cloud
// builds, where dotenv no-ops and the platform supplies the environment.
import dotenv from "dotenv";
import { resolve } from "path";
dotenv.config({ path: resolve(process.cwd(), ".env.local") });
dotenv.config({ path: resolve(process.cwd(), ".env") });

import { logTursoReplicaStartupGuard } from "./utils/tursoReplicaEnabled.js";
logTursoReplicaStartupGuard();

// CRITICAL: Ensure crypto is available globally for @mastra/core
// In newer Node.js versions (v16+), crypto is already global
// In older versions or some environments, we need to import it
import crypto from "crypto";
if (!globalThis.crypto) {
  // Only set if not already present
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto = crypto;
}

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { initializeAgentService } from "./services/AgentService.js";
import { registerAppFilesRoutes } from "./services/appFiles/appFilesRoutes.js";
import { getPaprAppsRoot, getPaprRoot, isCloudAgentGatewayMode } from "../core/utils/paprRoot.js";
import {
  clearGatewaySyncBusy,
  clearStaleGatewaySyncBusy,
  readGatewaySyncBusyState,
  isGatewaySyncBusyGraceActive,
} from "./services/cloudSync/syncBusyState.js";
import {
  sampleEventLoopLagMs,
  startGatewayEventLoopMonitor,
  stopGatewayEventLoopMonitor,
} from "./services/gatewayEventLoopMonitor.js";
import { scheduleCoalescedBackgroundWork } from "./services/gatewayBackgroundWork.js";
import {
  createSyncItemsRouteTimer,
  logSyncItemsRoute,
} from "./utils/syncItemsRouteLog.js";
import {
  applyActiveWorkspaceEnv,
  readActiveWorkspacePointer,
} from "../core/utils/paprWorkspace.js";
import {
  applyGatewayPaprApiKey,
  switchActiveWorkspace,
  getWorkspaceSwitchHealthStatus,
  getWorkspaceSwitchStatus,
} from "./services/workspaceSwitchService.js";
import { workspaceReadinessMiddleware } from "./services/workspaceReadiness.js";
import { createGatewayBootGate } from "./services/gatewayBootGate.js";
import { initializeChatService } from "./services/ChatService.js";
import { initializeDocumentService } from "./services/DocumentService.js";
import { initializeAppService, getAppService } from "./services/AppService.js";
import {
  resolveAppDataSource,
} from "./services/appDataSources.js";
import { resolveMiniAppIdFromRequest } from "./utils/inferMiniAppIdFromRequest.js";
import {
  registerCloudDesktopPreviewApiProxy,
  registerCloudDesktopPreviewRoutes,
} from "./services/appRuntime/cloudDesktopPreviewProxy.js";
import { registerCloudPreviewSessionSeedRoute } from "./services/appRuntime/cloudPreviewSessionSeed.js";
import type { Request } from "express";
import {
  initializeJobsService,
  getJobsService,
  JobsService,
  type CreateJobInput,
} from "./services/JobsService.js";
import { initializeSkillService } from "./services/SkillService.js";
import { initializeBundleService } from "./services/BundleService.js";
import { initializeSubAgentService } from "./services/SubAgentService.js";
import { initializePlanService } from "./services/PlanService.js";
import { getJobsScheduler } from "./services/JobsScheduler.js";
import { initializeWorkspaceService } from "./services/WorkspaceService.js";
import { setupWebSocketHandlers, broadcast } from "./websocket/index.js";
import { getJobEventHub } from "./services/JobEventHub.js";
import { registerJobEventsSseRoutes } from "./services/registerJobEventsSse.js";
import { registerPaprMiniAppSdkRoutes } from "./utils/registerPaprMiniAppSdkRoutes.js";
import { registerAppAgentChatRoutes } from "./services/appAgentChat/registerAppAgentChatRoutes.js";
import { getFileAppAgentChatSessionStore } from "./services/appAgentChat/AppAgentChatSessionStore.js";
import {
  initializePermissionBridge,
  requestPermissionFromMain,
} from "./permissions/GatewayPermissionBridge.js";
import { setPermissionRequester } from "./permissions/PermissionRequester.js";
import type { KeyPermissionRequest } from "../core/types/permissions.js";
import { initializeDbPool } from "./services/DbQueryPool.js";
import { initializeDbRouter } from "./services/appRuntime/DbRouter.js";
import { prepareRendererTelemetry, sendPreparedRendererTelemetry } from "./services/rendererTelemetryForward.js";
import { getPaprApiKey } from "./utils/keyResolver.js";
import { getMemoryServerBaseUrl } from "./utils/cloudApiClient.js";
import {
  initializeCloudSyncService,
  getCloudSyncService,
} from "./services/CloudSyncService.js";
import { ensureTursoSyncBridge } from "./services/TursoSyncBridge.js";
import { buildTursoSyncItemsReport } from "./services/tursoSyncStatus.js";
import { isLoopbackRequest } from "./utils/isLoopbackRequest.js";
import { buildCloudLinkSyncReport } from "./services/cloudPublishStatus.js";
import {
  getCachedCloudLinkSyncReport,
  invalidateCloudLinkSyncReportCache,
  setCachedCloudLinkSyncReport,
} from "./services/syncItemsCache.js";
import {
  getCachedTursoSyncItemsReport,
  invalidateTursoSyncItemsCache,
  setCachedTursoSyncItemsReport,
  tursoSyncItemsCacheKey,
} from "./services/tursoSyncItemsCache.js";
import {
  getCachedSyncItemsAppResponse,
  invalidateSyncItemsAppResponseCache,
  setCachedSyncItemsAppResponse,
} from "./services/syncItemsAppResponseCache.js";
import {
  buildLocalDbReadCacheKey,
  getCachedLocalDbReadResult,
  invalidateLocalDbReadCacheForApp,
  setCachedLocalDbReadResult,
} from "./services/appRuntime/localDbReadCache.js";
import {
  buildLocalDbBatchCoalesceKey,
  coalesceInFlightLocalDbRead,
} from "./services/appRuntime/localDbReadCoalesce.js";
import {
  getCloudAppPublishService,
} from "./services/CloudAppPublishService.js";
import {
  CloudCatalogInstallChoiceRequiredError,
  runCloudCatalogInstall,
} from "./services/runCloudCatalogInstall.js";
import {
  discoverAppRequirements,
  writeAppRequirements,
} from "./services/cloudAppRequirements.js";
import type { RequiredKeySpec } from "../core/types/bundles.js";
import { getCloudAppLineageService } from "./services/CloudAppLineageService.js";
import { getCloudAppContributeService } from "./services/CloudAppContributeService.js";
import { getCloudAppTrackSyncService } from "./services/CloudAppTrackSyncService.js";
import {
  getAppPublishPrefs,
  setAppPublishPrefs,
  type CloudAccessMode,
} from "./services/cloudPublishPrefs.js";
import { prefsSharingFieldsChanged } from "./services/cloudPublishDrift.js";
import {
  initializeVaultSyncService,
  getVaultSyncService,
} from "./services/VaultSyncService.js";
import { getCustomKeysService } from "./services/CustomKeysService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isExpectedJobRunCollision(err: unknown): boolean {
  return (
    err instanceof JobsService.DependencyRunningError ||
    (err instanceof Error && err.message === "Job is already running")
  );
}

// Configuration
const PORT = process.env.GATEWAY_PORT || 18789;
// Listen on all interfaces (0.0.0.0) to accept connections from both localhost and 127.0.0.1
const HOST = process.env.GATEWAY_HOST || "0.0.0.0";

/**
 * Initialize all services
 */
async function initializeServices(): Promise<void> {
  console.log("[Gateway] Initializing services...");

  const { timeStartupStep, timeStartupSync } = await import(
    "./services/gatewayStartupTiming.js"
  );

  try {
    await timeStartupStep("services", "toolResultTruncationSettings", async () => {
      const { refreshToolResultTruncationSettings } = await import(
        "./services/agent/toolResultTruncationSettings.js"
      );
      await refreshToolResultTruncationSettings();
    });
    console.log("[Gateway] Tool truncation settings loaded");
    // DON'T request keys on startup!
    // AgentService will lazy-load them when first message is sent
    // This ensures ZERO keychain popups on app startup (matches V1 behavior)

    let storageMode: "local" | "papr" | "hybrid";

    if (process.env.STORAGE_MODE) {
      // Use explicit mode if set
      storageMode = process.env.STORAGE_MODE as "local" | "papr" | "hybrid";
    } else {
      // Default to local mode on startup
      // AgentService will upgrade to hybrid/papr when keys are available
      storageMode = "local";
      console.log(
        "[Gateway] Starting in local mode (keys will load on first use)",
      );
    }

    console.log("[Gateway] Initializing AgentService...");
    await timeStartupStep("services", "AgentService", () =>
      initializeAgentService({
        mode: storageMode,
        paprApiKey: undefined, // Will be loaded lazily
        openaiApiKey: undefined, // Will be loaded lazily
      }),
    );
    console.log("[Gateway] AgentService initialized");

    // Initialize workspace (creates ~/Papr/workspace/ and templates on first run)
    console.log("[Gateway] Initializing WorkspaceService...");
    await timeStartupStep("services", "WorkspaceService", () =>
      initializeWorkspaceService(),
    );
    console.log("[Gateway] WorkspaceService initialized");

    // Note: Code indexing now uses lazy initialization
    // It will start automatically when PAPR_API_KEY is first used by an agent

    // Initialize other services
    console.log("[Gateway] Initializing ChatService...");
    await timeStartupStep("services", "ChatService", () => initializeChatService());
    console.log("[Gateway] ChatService initialized");

    console.log("[Gateway] Initializing DocumentService...");
    await timeStartupStep("services", "DocumentService", () =>
      initializeDocumentService(),
    );
    console.log("[Gateway] DocumentService initialized");

    console.log("[Gateway] Initializing AppService...");
    await timeStartupStep("services", "AppService", () => initializeAppService());
    console.log("[Gateway] AppService initialized");

    console.log("[Gateway] Initializing JobsService...");
    await timeStartupStep("services", "JobsService", () => initializeJobsService());
    console.log("[Gateway] JobsService core ready (maintenance in background)");

    if (
      process.env.CLOUD_SYNC_ENABLED !== "false" &&
      process.env.TURSO_SYNC_ENABLED !== "false"
    ) {
      timeStartupSync("services", "TursoSyncBridge", () => {
        ensureTursoSyncBridge();
      });
      console.log(
        "[Gateway] TursoSyncBridge initialized (replica credentials ready)",
      );
    }

    console.log("[Gateway] Initializing SkillService...");
    await timeStartupStep("services", "SkillService", () =>
      initializeSkillService(),
    );
    console.log("[Gateway] SkillService initialized");

    console.log("[Gateway] Initializing BundleService...");
    await timeStartupStep("services", "BundleService", () =>
      initializeBundleService(),
    );
    console.log("[Gateway] BundleService initialized");

    console.log("[Gateway] Initializing SubAgentService...");
    await timeStartupStep("services", "SubAgentService", () =>
      initializeSubAgentService(),
    );
    console.log("[Gateway] SubAgentService initialized");

    console.log("[Gateway] Initializing PlanService...");
    await timeStartupStep("services", "PlanService", () => initializePlanService());
    console.log("[Gateway] PlanService initialized");

    await timeStartupStep("services", "appRepoRevisionSubscriber", async () => {
      const { startAppRepoRevisionSubscriber } = await import(
        "./services/syncV3/appRepoRevisionSubscriber.js"
      );
      startAppRepoRevisionSubscriber();
    });

    console.log("[Gateway] All services initialized");
    console.log(
      `[Gateway] Storage mode: ${storageMode} (keys will load on demand)`,
    );
  } catch (error) {
    console.error("[Gateway] Failed to initialize services:", error);
    throw error;
  }
}

/**
 * Start the Gateway server
 */
const productionUiPath =
  process.env.NODE_ENV === "production"
    ? path.join(__dirname, "../ui")
    : null;

function registerEarlyProductionUi(app: express.Application): void {
  if (!productionUiPath) return;

  app.use(
    express.static(productionUiPath, {
      setHeaders: (res, filepath) => {
        if (filepath.endsWith(".js") || filepath.endsWith(".mjs")) {
          res.setHeader(
            "Content-Type",
            "application/javascript; charset=utf-8",
          );
        }
      },
    }),
  );

  app.get("/", (_req, res) => {
    res.sendFile(path.join(productionUiPath, "index.html"));
  });

  console.log("[Gateway] Serving UI static assets (early):", productionUiPath);
}

function registerProductionUiCatchAll(app: express.Application): void {
  if (!productionUiPath) return;

  app.use((req, res, next) => {
    if (req.path.startsWith("/assets/")) {
      return next();
    }
    // Unknown /api/* must not fall through to the SPA shell (apps parse HTML as JSON).
    if (req.path.startsWith("/api/")) {
      res.status(404).json({ error: `Unknown API route: ${req.method} ${req.path}` });
      return;
    }
    res.sendFile(path.join(productionUiPath, "index.html"));
  });
}

async function listenGatewayServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        console.error(`[Gateway] ERROR: Port ${PORT} is already in use!`);
        console.error(`[Gateway] Another Gateway process may be running.`);
        console.error(`[Gateway] Run: npm run kill:gateway`);
        reject(error);
      } else {
        console.error("[Gateway] Server error:", error);
        reject(error);
      }
    });

    server.listen(PORT as number, HOST, () => {
      console.log(`[Gateway] Server listening on http://${HOST}:${PORT}`);
      console.log(`[Gateway] WebSocket available at ws://${HOST}:${PORT}`);
      resolve();
    });
  });
}

async function startGateway(): Promise<void> {
  console.log("[Gateway] Paprwork V2 Gateway starting...");
  console.log("[Gateway] Platform:", process.platform);
  console.log("[Gateway] Node:", process.version);

  const activeWorkspace = readActiveWorkspacePointer();
  if (activeWorkspace) {
    applyActiveWorkspaceEnv(activeWorkspace);
    console.log(
      `[Gateway] Active workspace: org=${activeWorkspace.organizationId} ns=${activeWorkspace.namespaceId}`,
    );

  }

  try {
    const {
      beginGatewayStartupTiming,
      timeStartupStep,
      timeStartupSync,
      beginRouteRegistrationTiming,
      lapRouteRegistrationSection,
      printGatewayStartupSummary,
    } = await import("./services/gatewayStartupTiming.js");
    beginGatewayStartupTiming();

    // Initialize permission system
    console.log("[Gateway] Initializing permission system...");
    timeStartupSync("pre-http", "permissionBridge", () => {
      initializePermissionBridge();
    });
    setPermissionRequester(async (request: KeyPermissionRequest) => {
      return await requestPermissionFromMain(request);
    });
    console.log("[Gateway] Permission system initialized");

    // Set up key cache invalidation listener
    console.log("[Gateway] Setting up key cache invalidation listener...");
    await timeStartupStep("pre-http", "keyCacheInvalidationListener", async () => {
      const { setupKeyCacheInvalidationListener } = await import(
        "./utils/keyResolver.js"
      );
      setupKeyCacheInvalidationListener();
    });
    console.log("[Gateway] Key cache invalidation listener ready");

    await timeStartupStep("pre-http", "paprQuotaListener", async () => {
      const { setPaprQuotaExceededListener } = await import(
        "../core/utils/paprQuota.js"
      );
      const { broadcastPaprQuotaStatus } = await import(
        "./utils/paprQuotaNotify.js"
      );
      setPaprQuotaExceededListener(broadcastPaprQuotaStatus);
    });
    console.log("[Gateway] Papr quota status listener ready");

    // Bind HTTP early so supervisor health checks succeed while services load.
    // Large chats.db + tool registration can take 60s+ on cold start.
    // Clear stale busy marker from a previous gateway process (crash mid-upload).
    clearGatewaySyncBusy();
    clearStaleGatewaySyncBusy();
    let gatewayReady = false;
    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ server });

    // The desktop renderer runs on a Vite port in development while the
    // gateway stays on 18789. Allow only loopback renderer origins; never
    // expose the local gateway to arbitrary websites.
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin) {
        try {
          const url = new URL(origin);
          if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
          }
        } catch {
          // Invalid Origin headers receive no CORS grant.
        }
      }
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });

    app.use(workspaceReadinessMiddleware);

    app.get("/health", (_req, res) => {
      if (getWorkspaceSwitchHealthStatus() === "switching") {
        res.json({
          status: "switching",
          timestamp: Date.now(),
        });
        return;
      }
      clearStaleGatewaySyncBusy();
      const syncBusy = isGatewaySyncBusyGraceActive(readGatewaySyncBusyState());
      const eventLoopLagMs = Math.round(sampleEventLoopLagMs(false));
      res.json({
        status: gatewayReady ? "ok" : "starting",
        timestamp: Date.now(),
        ...(syncBusy ? { syncBusy: true } : {}),
        ...(eventLoopLagMs >= 200 ? { eventLoopLagMs } : {}),
      });
    });

    timeStartupSync("pre-http", "expressAppAndHealthRoute", () => {
      registerEarlyProductionUi(app);
    });

    // Everything below this point is registered after `initializeServices()`,
    // which on a cold start can take longer than the 60s the main process waits
    // before loading the UI anyway. Without this, requests arriving in that
    // window fell through to Express's default 404 — so an app that was merely
    // not-yet-routable rendered "Cannot GET /apps/<id>/index.html", which reads
    // as "deleted". Registered after the early UI static handler so the app
    // shell can still load, and before `listen` so it covers the whole window.
    app.use(createGatewayBootGate(() => gatewayReady));

    await timeStartupStep("pre-http", "listenGatewayServer", () =>
      listenGatewayServer(server),
    );
    startGatewayEventLoopMonitor();
    console.log("[Gateway] Health endpoint live (services still loading)...");

    await timeStartupStep("services", "initializeServices (total)", () =>
      initializeServices(),
    );

    timeStartupSync("routes", "websocketHandlers", () => {
      setupWebSocketHandlers(wss);
      getJobEventHub().subscribe((event) => {
        broadcast({ type: event.type, data: event.data });
      });
    });
    console.log("[Gateway] WebSocket server created");

    beginRouteRegistrationTiming();

    // ── Mini-app SQLite query API ────────────────────────────────────────────
    // All synchronous better-sqlite3 calls run in a worker-thread pool so they
    // never block the main event loop (keeps health checks & WebSocket alive).
    //
    // Apps call: fetch('/api/db/query', { method: 'POST', body: JSON.stringify({ sql, params }) })
    // appId is optional when called from a mini-app iframe — inferred from Referer (/apps/{uuid}/…).
    // Apps call: fetch('/api/db/schema') — appId inferred the same way, or pass ?appId=
    //
    // Security:
    //  - Only SELECT statements allowed on /query (read-only)
    //  - Only db paths that are registered in the app's data-sources.json
    //  - Path traversal blocked at the linked dbPath level
    //
    // Source routing (when sourceId is omitted):
    //  - Single linked source → use it automatically
    //  - Legacy `primary` alias (or role: primary) → that source only
    //  - Multiple sources without legacy default → sourceId required (400)
    // ─────────────────────────────────────────────────────────────────────────

    const { resolveDbQueryPoolSize } = await import(
      "./services/gatewayBackgroundConcurrency.js"
    );
    const dbPool = initializeDbPool(
      new URL("./workers/db-query-worker.js", import.meta.url),
      resolveDbQueryPoolSize(),
    );
    const dbRouter = initializeDbRouter(dbPool);

    async function resolveLinkedSource(
      appId: string,
      sourceId: string | undefined,
      sql: string | undefined,
      operation: "read" | "write",
    ): Promise<import("./services/appDataSources.js").AppDataSource> {
      const appService = getAppService();
      const config = await appService.getDataSourcesConfig(appId);
      if (!config.sources.length) {
        throw Object.assign(
          new Error(
            `No data sources linked to app ${appId}. Use link_app_data_source first.`,
          ),
          { status: 404 },
        );
      }
      return resolveAppDataSource(config, {
        sourceId,
        sql,
        operation,
        tableExists: (dbPath, table) => {
          const source = config.sources.find(
            (entry) => path.normalize(entry.dbPath) === path.normalize(dbPath),
          );
          if (!source) {
            return dbPool.tableExists(dbPath, table);
          }
          return dbRouter.tableExists(dbPath, table, source);
        },
      });
    }

    function resolveRequestAppId(
      req: Request,
      explicitAppId: string | undefined,
    ): { appId: string } | { error: string; status: number } {
      const resolved = resolveMiniAppIdFromRequest(explicitAppId, req.headers);
      if (!resolved.appId) {
        return {
          error: resolved.error ?? "appId is required",
          status: resolved.status ?? 400,
        };
      }
      return { appId: resolved.appId };
    }

    app.use((req, _res, next) => {
      (req as import("express").Request & { paprReceivedAt?: number }).paprReceivedAt =
        performance.now();
      next();
    });
    app.use(express.json({ limit: "5mb" }));

    registerCloudDesktopPreviewApiProxy(app);
    registerCloudPreviewSessionSeedRoute(app);

    app.get("/api/db/schema", async (req, res) => {
      try {
        const explicitAppId = req.query["appId"] as string | undefined;
        const resolved = resolveRequestAppId(req, explicitAppId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const appId = resolved.appId;
        const appService = getAppService();
        const sources = await appService.listAppDataSources(appId);
        if (!sources.length) {
          res.status(404).json({
            error: `No data sources linked to app ${appId}. Create a job with appIds: ["${appId}"] or call link_app_data_source first.`,
            sources: [],
          });
          return;
        }

        const result = await Promise.all(
          sources.map(async (source) => {
            try {
              const schema = await dbRouter.schema(source.dbPath, source);
              return {
                sourceId: source.id,
                alias: source.alias,
                dbPath: source.dbPath,
                tables: schema.tables,
              };
            } catch (err) {
              return {
                sourceId: source.id,
                alias: source.alias,
                dbPath: source.dbPath,
                error: (err as Error).message,
              };
            }
          }),
        );

        res.json({ sources: result });
      } catch (err) {
        console.error("[Gateway] /api/db/schema error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/apps/:appId/data-health", async (req, res) => {
      try {
        const appId = req.params.appId;
        if (!appId) {
          res.status(400).json({ error: "appId required" });
          return;
        }
        const { getDataContractService } = await import(
          "./services/DataContractService.js"
        );
        const report = await getDataContractService().getDataHealth(appId);
        res.json(report);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("App not found")) {
          res.status(404).json({ error: message });
          return;
        }
        console.error("[Gateway] /api/apps/data-health error:", err);
        res.status(500).json({ error: message });
      }
    });

    app.get("/api/apps/:appId/feature-availability", async (req, res) => {
      try {
        const appId = req.params.appId?.trim();
        if (!appId) {
          res.status(400).json({ error: "appId required" });
          return;
        }
        const { assessAppFeatureAvailabilityForApp } = await import(
          "./services/cloudAppPublishReadiness.js"
        );
        const report = await assessAppFeatureAvailabilityForApp(appId);
        res.json(report);
      } catch (err) {
        console.error("[Gateway] /api/apps/feature-availability error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    /** Public embedded sub-agent chat config for mini-app SDK */
    app.get("/api/apps/:appId/agent-chat", async (req, res) => {
      try {
        const appId = req.params.appId;
        if (!appId) {
          res.status(400).json({ error: "appId required" });
          return;
        }
        const { getAppService } = await import("./services/AppService.js");
        const { toPublicAppAgentChatConfig } = await import(
          "../core/types/appAgentChat.js"
        );
        const appService = getAppService();
        await appService.initialize();
        const miniApp = await appService.getApp(appId);
        if (!miniApp) {
          res.status(404).json({ error: "App not found" });
          return;
        }
        const agentChat = miniApp.agentChat
          ? toPublicAppAgentChatConfig(miniApp.agentChat)
          : null;
        res.json({ appId, agentChat });
      } catch (err) {
        console.error("[Gateway] /api/apps/agent-chat error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/apps/:appId/runtime-logs", async (req, res) => {
      try {
        const appId = req.params.appId;
        if (!appId) {
          res.status(400).json({ error: "appId required" });
          return;
        }
        const limitRaw = req.query.limit;
        const sinceRaw = req.query.sinceMs;
        const limit =
          typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : 100;
        const sinceMs =
          typeof sinceRaw === "string" ? Number.parseInt(sinceRaw, 10) : undefined;
        const { getAppRuntimeLogService } = await import(
          "./services/AppRuntimeLogService.js"
        );
        const logs = getAppRuntimeLogService().getLogs(appId, {
          limit: Number.isFinite(limit) ? limit : 100,
          sinceMs: Number.isFinite(sinceMs) ? sinceMs : undefined,
        });
        res.json({ appId, logs });
      } catch (err) {
        console.error("[Gateway] /api/apps/runtime-logs error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    lapRouteRegistrationSection("mini-app-db-query-api");

    // ── Database registry (independent first-class DBs) ──
    app.get("/api/databases", async (_req, res) => {
      try {
        const { initializeDatabaseRegistry } = await import(
          "./services/DatabaseRegistryService.js"
        );
        const registry = await initializeDatabaseRegistry();
        const databases = await Promise.all(
          registry.listActive().map(async (record) => ({
            dbId: record.dbId,
            label: record.label ?? record.dbId,
            localPath: record.localPath,
            tursoShortName: record.tursoShortName,
            ownerJobId: record.ownerJobId,
            isolation: record.isolation,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            linkedAppCount: await registry.countReferences(
              record.dbId,
              record.localPath,
            ),
            linkedAppIds: await registry.listReferencingAppIds(
              record.dbId,
              record.localPath,
            ),
          })),
        );
        res.json({ databases });
      } catch (err) {
        console.error("[Gateway] /api/databases error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/apps/:appId/link-database", async (req, res) => {
      try {
        const appId = req.params.appId;
        const body = req.body as {
          dbId?: string;
          alias?: string;
        };
        if (!appId || !body.dbId) {
          res.status(400).json({ error: "appId and dbId required" });
          return;
        }
        const { initializeDatabaseRegistry } = await import(
          "./services/DatabaseRegistryService.js"
        );
        const registry = await initializeDatabaseRegistry();
        const record = registry.getById(body.dbId);
        if (!record) {
          res.status(404).json({ error: `Database not found: ${body.dbId}` });
          return;
        }
        const appService = getAppService();
        await appService.initialize();
        const { resolveAttachAlias } = await import(
          "./services/appDataSources.js"
        );
        const alias = resolveAttachAlias({
          requested: body.alias,
          registryLabel: record.label,
          dbId: body.dbId,
        });
        const sources = await appService.linkAppDataSource(appId, {
          id: `${body.dbId}:${alias}`,
          type: "sqlite",
          dbId: body.dbId,
          alias,
          dbPath: record.localPath,
          tables: [],
        });
        res.json({ success: true, sources });
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("App not found")) {
          res.status(404).json({ error: message });
          return;
        }
        console.error("[Gateway] /api/apps/link-database error:", err);
        res.status(500).json({ error: message });
      }
    });

    app.get("/api/apps/:appId/remote-code-status", async (req, res) => {
      try {
        const appId = req.params.appId;
        if (!appId) {
          res.status(400).json({ error: "appId required" });
          return;
        }
        const { checkAppRemoteCodeStatus } = await import(
          "./services/syncV3/checkAppRemoteCodeStatus.js"
        );
        const { checkPublisherUpstreamRevision } = await import(
          "./services/syncV3/checkPublisherUpstreamRevision.js"
        );
        const { getPendingAppUpdate } = await import(
          "./services/syncV3/appRepoPendingUpdate.js"
        );
        const [status, publisher] = await Promise.all([
          checkAppRemoteCodeStatus(appId),
          checkPublisherUpstreamRevision(appId),
        ]);
        // pendingUpdate: a remote commit arrived but auto-pull was deferred
        // (pending row push, conflicts). Share bar shows "Update waiting".
        res.json({ ...status, ...publisher, pendingUpdate: getPendingAppUpdate(appId) });
      } catch (err) {
        console.error("[Gateway] /api/apps/remote-code-status error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/apps/:appId/sync-from-cloud", async (req, res) => {
      const { PhaseTimer } = await import("./utils/phaseTiming.js");
      try {
        const appId = req.params.appId;
        if (!appId) {
          res.status(400).json({ error: "appId required" });
          return;
        }
        const body = (req.body ?? {}) as { wait?: boolean; resolution?: string };
        const waitForCompletion = body.wait === true;
        const resolution =
          body.resolution === "take_theirs" || body.resolution === "keep_mine"
            ? body.resolution
            : "hold";
        const sync = getCloudSyncService();
        const token = sync ? await sync.ensureFreshToken() : null;

        // No background pull — use GET remote-code-status to detect updates, then POST with wait:true.
        if (!waitForCompletion) {
          res.status(400).json({
            error:
              "Background pull disabled. Poll GET /api/apps/:appId/remote-code-status and POST with { wait: true } to pull.",
          });
          return;
        }

        const timer = new PhaseTimer();
        const { pullAppFromCloud } = await import(
          "./services/syncV3/pullAppFromCloud.js"
        );
        const result = await pullAppFromCloud(appId, {
          token,
          waitForTurso: true,
          allowRecentSkip: false,
          preferCloudOverLocal: true,
          resolution,
        });
        timer.mark("pullAppFromCloud");
        if (result.code.skipped && result.code.reason) {
          console.log(
            `[Gateway] /api/apps/sync-from-cloud skipped for ${appId}: ${result.code.reason.slice(0, 120)}`,
          );
        }
        timer.logIfSlow(`Gateway sync-from-cloud app=${appId}`, 200);
        res.json({ success: true, ...result });
      } catch (err) {
        console.error("[Gateway] /api/apps/sync-from-cloud error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Diagnostics: per-op worker timings (queue wait vs engine time) for replica stalls.
    app.get("/api/debug/turso-worker-timings", async (_req, res) => {
      const { getTursoReplicaSyncWorkerClient } = await import(
        "./services/tursoReplica/TursoReplicaSyncWorkerClient.js"
      );
      res.json({ timings: getTursoReplicaSyncWorkerClient().getRecentTimings() });
    });

    app.get("/api/debug/replica-read-phases", async (_req, res) => {
      const { getRecentReplicaReadPhaseTraces } = await import(
        "./services/tursoReplica/replicaReadPhaseTrace.js"
      );
      res.json({ traces: getRecentReplicaReadPhaseTraces() });
    });

    // Small, bounded diagnostic snapshots; no request contents or URLs retained.
    app.post("/api/debug/renderer-performance", async (req, res) => {
      const { rendererPerformanceDiagnostics } = await import("./services/rendererPerformanceDiagnostics.js");
      if (!rendererPerformanceDiagnostics.record(req.body)) {
        res.status(400).json({ error: "Invalid or out-of-order renderer sample" });
        return;
      }
      res.status(204).end();
    });

    app.get(["/api/debug/gateway-background", "/api/debug/gateway-performance"], async (_req, res) => {
      const { getRecentBackgroundTaskTimings } = await import(
        "./services/gatewayBackgroundWork.js"
      );
      const { sampleEventLoopLagMs, getGatewayResourceDiagnostics } = await import(
        "./services/gatewayEventLoopMonitor.js"
      );
      const { getPerformanceDiagnostics } = await import(
        "../core/utils/performanceDiagnostics.js"
      );
      const { buildGatewayPerformanceTimeline } = await import(
        "./services/gatewayPerformanceTimeline.js"
      );
      const capturedAt = new Date().toISOString();
      const resources = getGatewayResourceDiagnostics();
      const operations = getPerformanceDiagnostics();
      const timeline = buildGatewayPerformanceTimeline({
        capturedAt,
        samples: resources.samples,
        active: operations.active,
        recent: operations.recent,
      });
      res.json({
        schemaVersion: 7,
        renderer: (await import("./services/rendererPerformanceDiagnostics.js")).rendererPerformanceDiagnostics.snapshot(),
        cloudPause: (await import("../core/utils/paprQuota.js")).getPaprCloudPauseDiagnostics(),
        capturedAt,
        process: { pid: process.pid, uptimeSeconds: process.uptime() },
        resources,
        operations,
        timeline,
        agentConcurrency: (await import("./services/agent/agentStreamConcurrency.js")).getAgentStreamConcurrencyGate().getStats(),
        backgroundBudget: (await import("./services/gatewayBackgroundBudget.js")).gatewayBackgroundBudget.stats(),
        recentTasks: getRecentBackgroundTaskTimings(),
        eventLoopLagMs: sampleEventLoopLagMs(false),
      });
    });

    app.get("/api/debug/gateway-performance/view", async (_req, res) => {
      const { readFile } = await import("node:fs/promises");
      const viewPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "resources",
        "gateway-performance-view.html",
      );
      const html = await readFile(viewPath, "utf8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    });

    app.get("/api/dev/papr-api-catalog", async (req, res) => {
      try {
        const { getPaprApiCatalog } = await import(
          "../core/paprApiCatalog/loadCatalog.js"
        );
        const { searchPaprApiCatalog, formatCatalogEntryForAgent } = await import(
          "../core/paprApiCatalog/searchCatalog.js"
        );
        const catalog = getPaprApiCatalog();
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
        if (!q) {
          res.json(catalog);
          return;
        }
        const surfaceRaw = req.query.surface;
        const surface =
          typeof surfaceRaw === "string" && surfaceRaw.length > 0
            ? surfaceRaw
            : "any";
        const limitRaw = req.query.limit;
        const limit =
          typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
            ? Number.parseInt(limitRaw, 10)
            : 10;
        const hits = searchPaprApiCatalog(catalog, {
          query: q,
          surface: surface as "any",
          limit,
        });
        res.json({
          query: q,
          surface,
          count: hits.length,
          results: hits.map((hit) => ({
            score: hit.score,
            ...formatCatalogEntryForAgent(hit.entry, "full"),
          })),
        });
      } catch (err) {
        console.error("[Gateway] /api/dev/papr-api-catalog error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/apps/:appId/normalize-databases", async (req, res) => {
      try {
        const appId = req.params.appId;
        if (!appId) {
          res.status(400).json({ error: "appId required" });
          return;
        }
        const apply = (req.body as { apply?: boolean } | undefined)?.apply === true;
        const { normalizeAppDatabases } = await import(
          "./services/dbPathNormalization.js"
        );
        const report = await normalizeAppDatabases(appId, { dryRun: !apply });
        res.json(report);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("App not found")) {
          res.status(404).json({ error: message });
          return;
        }
        console.error("[Gateway] /api/apps/normalize-databases error:", err);
        res.status(500).json({ error: message });
      }
    });

    app.post("/api/db/query", async (req, res) => {
      const receivedAt =
        (req as import("express").Request & { paprReceivedAt?: number }).paprReceivedAt ??
        performance.now();
      let traceActive = false;
      try {
        const { appId: bodyAppId, sourceId, sql, params } = req.body as {
          appId?: string;
          sourceId?: string;
          sql?: string;
          params?: unknown[];
        };

        if (!sql) {
          res.status(400).json({ error: "sql is required" });
          return;
        }

        const resolved = resolveRequestAppId(req, bodyAppId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const appId = resolved.appId;
        const { markMiniAppInteractiveLoadWindow } = await import(
          "./services/appRuntime/miniAppInteractiveLoadWindow.js"
        );
        markMiniAppInteractiveLoadWindow(appId);

        const trimmed = sql.trim().toLowerCase();
        if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
          res.status(403).json({
            error: "Only SELECT (and WITH ... SELECT) queries are allowed",
          });
          return;
        }

        let source: import("./services/appDataSources.js").AppDataSource;
        const resolveSourceStarted = performance.now();
        try {
          source = await resolveLinkedSource(appId, sourceId, sql, "read");
        } catch (err) {
          const e = err as Error & { status?: number };
          res.status(e.status ?? 400).json({ error: e.message });
          return;
        }

        const sourceKey = source.alias ?? source.dbPath;
        let cacheKey: string | undefined;
        if (isLoopbackRequest(req)) {
          cacheKey = buildLocalDbReadCacheKey({
            appId,
            sourceKey,
            sql,
            params,
          });
          const cached = getCachedLocalDbReadResult(cacheKey);
          if (cached) {
            const { notifyMiniAppFirstDataPaint } = await import(
              "./services/tursoPullScheduler.js"
            );
            notifyMiniAppFirstDataPaint(appId);
            res.json(cached);
            return;
          }
        }

        const { shouldUseTursoReplicaForSource } = await import(
          "./services/tursoReplica/tursoReplicaRouting.js"
        );
        const useReplicaTrace = shouldUseTursoReplicaForSource(source);
        const {
          withReplicaReadTrace,
          finishReplicaReadTrace,
          markReplicaReadPhase,
        } = await import("./services/tursoReplica/replicaReadPhaseTrace.js");

        const runQuery = async () => {
          const { withInteractiveHotPath } = await import(
            "./services/gatewayInteractivePriority.js"
          );
          const coalesceKey =
            cacheKey ??
            buildLocalDbReadCacheKey({ appId, sourceKey, sql, params });
          const routerStarted = performance.now();
          const result = await withInteractiveHotPath("mini-app:db-query", () =>
            coalesceInFlightLocalDbRead(coalesceKey, () =>
              dbRouter.query(appId, source, sql, params),
            ),
          );
          markReplicaReadPhase("dbRouterCoalesceMs", performance.now() - routerStarted);
          return result;
        };

        let result: Awaited<ReturnType<typeof dbRouter.query>>;
        if (useReplicaTrace) {
          traceActive = true;
          const resolveSourceMs = performance.now() - resolveSourceStarted;
          const httpQueueMs = performance.now() - receivedAt;
          result = await withReplicaReadTrace(
            `app=${appId} source=${source.alias ?? sourceKey}`,
            { appId, source: String(source.alias ?? sourceKey) },
            async () => {
              markReplicaReadPhase("httpQueueMs", httpQueueMs);
              markReplicaReadPhase("resolveSourceMs", resolveSourceMs);
              const routed = await runQuery();
              finishReplicaReadTrace({
                backend: routed.backend,
                rows: routed.count,
              });
              return routed;
            },
          );
        } else {
          result = await runQuery();
        }

        console.log(
          `[Gateway] /api/db/query app=${appId} source=${source.alias} backend=${result.backend} rows=${result.count}`,
        );
        const payload = { ...result, source: source.alias };
        if (cacheKey) {
          setCachedLocalDbReadResult(cacheKey, payload, appId);
        }
        const { notifyMiniAppFirstDataPaint } = await import(
          "./services/tursoPullScheduler.js"
        );
        notifyMiniAppFirstDataPaint(appId);
        res.json(payload);
      } catch (err) {
        const message = (err as Error).message;
        if (traceActive) {
          const { finishReplicaReadTrace, getReplicaReadTraceStore } = await import(
            "./services/tursoReplica/replicaReadPhaseTrace.js"
          );
          if (getReplicaReadTraceStore()) {
            finishReplicaReadTrace({ error: message.slice(0, 160) });
          }
        }
        console.error("[Gateway] /api/db/query error:", err);
        const { httpStatusForMiniAppDbQueryError } = await import(
          "./services/tursoReplica/replicaSchemaQueryErrorMessage.js"
        );
        res.status(httpStatusForMiniAppDbQueryError(message)).json({ error: message });
      }
    });
    lapRouteRegistrationSection("database-registry");

    // ── Mini-app batch read API ─────────────────────────────────────────────
    // Runs multiple read-only statements in one HTTP round trip. Mirrors the
    // Cloud App Host /api/db/batch contract so apps behave identically in
    // local preview and on apps.papr.ai.
    // Aliases: /api/db/query-batch and /api/db/read-batch (same handler).
    // Writes belong on POST /api/db/write-batch — never mix INSERT/UPDATE into batch.
    const handleDbReadBatch = async (
      req: import("express").Request,
      res: import("express").Response,
    ): Promise<void> => {
      try {
        const { appId: bodyAppId, sourceId: batchSourceId, statements } = req.body as {
          appId?: string;
          sourceId?: string;
          statements?: Array<{ sourceId?: string; sql?: string; params?: unknown[] }>;
        };
        if (!Array.isArray(statements) || statements.length === 0) {
          res.status(400).json({ error: "non-empty statements[] is required" });
          return;
        }

        const resolved = resolveRequestAppId(req, bodyAppId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const appId = resolved.appId;
        const { markMiniAppInteractiveLoadWindow } = await import(
          "./services/appRuntime/miniAppInteractiveLoadWindow.js"
        );
        markMiniAppInteractiveLoadWindow(appId);
        if (statements.length > 25) {
          res.status(400).json({ error: "Batch limited to 25 statements" });
          return;
        }

        const { withInteractiveHotPath } = await import(
          "./services/gatewayInteractivePriority.js"
        );
        const batchCoalesceKey = buildLocalDbBatchCoalesceKey(appId, statements);
        const { executeMiniAppReadBatch } = await import(
          "./services/appRuntime/miniAppDbReadBatch.js"
        );
        const { coalesceBatchSourceId } = await import("./services/appDataSources.js");
        type Prepared = import("./services/appRuntime/miniAppDbReadBatch.js").PreparedMiniAppReadStatement;
        const payload = await withInteractiveHotPath("mini-app:db-query-batch", () =>
          coalesceInFlightLocalDbRead(batchCoalesceKey, async () => {
            const prepared: Prepared[] = [];
            const validationRows: Array<Record<string, unknown>> = new Array(
              statements.length,
            );
            for (let index = 0; index < statements.length; index++) {
              const stmt = statements[index];
              const sql = stmt?.sql;
              if (!sql) {
                validationRows[index] = { ok: false, error: "sql is required" };
                continue;
              }
              const trimmed = sql.trim().toLowerCase();
              if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
                validationRows[index] = {
                  ok: false,
                  error: "Only SELECT (and WITH ... SELECT) queries are allowed",
                };
                continue;
              }
              try {
                const source = await resolveLinkedSource(
                  appId,
                  coalesceBatchSourceId(stmt.sourceId, batchSourceId),
                  sql,
                  "read",
                );
                prepared.push({ index, source, sql, params: stmt.params });
              } catch (resolveErr) {
                validationRows[index] = {
                  ok: false,
                  error: (resolveErr as Error).message,
                };
              }
            }

            const results: Array<Record<string, unknown>> = validationRows.map(
              (row) => row ?? { ok: false, error: "Statement was not executed" },
            );
            if (prepared.length > 0) {
              const executed = await executeMiniAppReadBatch(
                dbRouter,
                appId,
                prepared,
                statements.length,
              );
              for (let i = 0; i < statements.length; i++) {
                if (executed[i] !== undefined) {
                  results[i] = executed[i];
                }
              }
            }
            return { results };
          }),
        );
        const { notifyMiniAppFirstDataPaint } = await import(
          "./services/tursoPullScheduler.js"
        );
        notifyMiniAppFirstDataPaint(appId);
        res.json(payload);
      } catch (err) {
        console.error("[Gateway] /api/db/batch error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    };
    app.post("/api/db/batch", handleDbReadBatch);
    app.post("/api/db/query-batch", handleDbReadBatch);
    app.post("/api/db/read-batch", handleDbReadBatch);

    lapRouteRegistrationSection("mini-app-batch-read-api");

    // ── Mini-app SQLite write API ────────────────────────────────────────────
    // Apps call: fetch('/api/db/write', { method: 'POST', body: JSON.stringify({ appId, sql, params }) })
    //
    // Allows INSERT / UPDATE / DELETE / UPSERT / REPLACE on linked sources only.
    // Security:
    //  - SELECT and DDL (CREATE/DROP/ALTER) are rejected — use /api/db/query for reads
    //  - Only db paths registered in the app's data-sources.json
    //  - Bound params required for any user-supplied values (prevents SQL injection)
    //
    // Returns: { changes: number, lastInsertRowid: number }
    //
    // Turso push: TursoLinkedDbWatcher schedules debounced push on data.db/WAL
    // changes — no explicit scheduleTursoPushForJob here (avoids double enqueue).
    // ─────────────────────────────────────────────────────────────────────────

    app.post("/api/db/write", async (req, res) => {
      try {
        const { appId: bodyAppId, sourceId, sql, params } = req.body as {
          appId?: string;
          sourceId?: string;
          sql?: string;
          params?: unknown[];
        };

        if (!sql) {
          res.status(400).json({ error: "sql is required" });
          return;
        }

        const resolved = resolveRequestAppId(req, bodyAppId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const appId = resolved.appId;

        const trimmed = sql.trim().toLowerCase();
        const isWrite =
          trimmed.startsWith("insert") ||
          trimmed.startsWith("update") ||
          trimmed.startsWith("delete") ||
          trimmed.startsWith("replace") ||
          trimmed.startsWith("upsert");
        if (!isWrite) {
          res.status(403).json({
            error:
              "Only INSERT, UPDATE, DELETE, REPLACE, and UPSERT are allowed on /api/db/write. Use /api/db/query for SELECT.",
          });
          return;
        }

        let source: import("./services/appDataSources.js").AppDataSource;
        try {
          source = await resolveLinkedSource(appId, sourceId, sql, "write");
        } catch (err) {
          const e = err as Error & { status?: number };
          res.status(e.status ?? 400).json({ error: e.message });
          return;
        }

        const { writeLinkedDbRowLocalFirst } = await import(
          "./services/syncV3/localFirstDbWrite.js"
        );
        const { assertReplaySafeRowSql } = await import(
          "./services/syncV3/replaySafeSql.js"
        );
        assertReplaySafeRowSql(sql);
        const { assertValidHomeBriefWrite } = await import(
          "./services/dailyBriefWriteGuard.js"
        );
        assertValidHomeBriefWrite(appId, source, sql, params);
        const result = await writeLinkedDbRowLocalFirst(
          dbPool,
          dbRouter,
          appId,
          source,
          sql,
          params,
        );
        console.log(
          `[Gateway] /api/db/write app=${appId} source=${source.alias} changes=${result.changes}`,
        );
        invalidateLocalDbReadCacheForApp(appId);
        invalidateTursoSyncItemsCache(appId);
        invalidateSyncItemsAppResponseCache(appId);
        res.json(result);
      } catch (err) {
        const e = err as Error & { status?: number; name?: string };
        if (e.name === "NonReplaySafeSqlError") {
          res.status(400).json({ error: e.message });
          return;
        }
        console.error("[Gateway] /api/db/write error:", err);
        res.status(e.status ?? 500).json({ error: e.message });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    lapRouteRegistrationSection("mini-app-write-api");

    // ── Mini-app SQLite write batch API ─────────────────────────────────────
    // Apps call: fetch('/api/db/write-batch', { method: 'POST', body: JSON.stringify({ appId, statements: [...] }) })
    // Same write rules as /api/db/write; up to 25 statements per request.
    // Returns: { atomic: boolean, results: [{ ok, changes, lastInsertRowid, source?, error? }, ...] }
    // Default atomic: false — partial commits possible. Pass atomic: true for one SQLite transaction
    // (all statements must target the same linked database).
    // ─────────────────────────────────────────────────────────────────────────

    app.post("/api/db/write-batch", async (req, res) => {
      try {
        const { appId: bodyAppId, sourceId: batchSourceId, statements, atomic } =
          req.body as {
            appId?: string;
            sourceId?: string;
            statements?: Array<{ sourceId?: string; sql?: string; params?: unknown[] }>;
            atomic?: boolean;
          };

        if (!Array.isArray(statements) || statements.length === 0) {
          res.status(400).json({ error: "non-empty statements[] is required" });
          return;
        }
        if (statements.length > 25) {
          res.status(400).json({ error: "Batch limited to 25 statements" });
          return;
        }

        const resolved = resolveRequestAppId(req, bodyAppId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const appId = resolved.appId;

        const { executeMiniAppWriteBatch } = await import(
          "./services/miniAppWriteBatch.js"
        );
        const { coalesceBatchSourceId } = await import("./services/appDataSources.js");

        const payload = await executeMiniAppWriteBatch({
          appId,
          statements: statements.map((stmt) => ({
            ...stmt,
            sourceId: coalesceBatchSourceId(stmt.sourceId, batchSourceId),
          })),
          atomic: atomic === true,
          pool: dbPool,
          dbRouter,
          resolveLinkedSource,
        });

        console.log(
          `[Gateway] /api/db/write-batch app=${appId} count=${statements.length} atomic=${payload.atomic}`,
        );
        invalidateLocalDbReadCacheForApp(appId);
        invalidateTursoSyncItemsCache(appId);
        invalidateSyncItemsAppResponseCache(appId);
        res.json(payload);
      } catch (err) {
        const e = err as Error & { status?: number };
        if (e.status) {
          res.status(e.status).json({ error: e.message });
          return;
        }
        console.error("[Gateway] /api/db/write-batch error:", err);
        res.status(500).json({ error: e.message });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    lapRouteRegistrationSection("mini-app-write-batch-api");

    // ── Backend handler DB proxy (loopback — same rules as /api/db/*) ───────
    // Python papr_db uses PAPR_DB_MODE=proxy to route query/write here instead
    // of raw sqlite3 or Turso tokens in the subprocess.
    // ─────────────────────────────────────────────────────────────────────────
    const { createDesktopBackendDbProxyRouter } = await import(
      "./services/appRuntime/backendDbProxy.js"
    );
    app.use(
      "/internal/backend-db",
      createDesktopBackendDbProxyRouter({
        resolveSource: resolveLinkedSource,
        resolveRegistrySource: async (dbId, sourceId) => {
          const { getDatabaseRegistryService } = await import(
            "./services/DatabaseRegistryService.js"
          );
          const { resolveExistingRegistryDbPath, targetFromRegistryRecord } =
            await import("./services/jobAppDatabase.js");
          const record = getDatabaseRegistryService().getById(dbId);
          if (!record || record.status !== "active") {
            throw Object.assign(new Error(`Database not found: ${dbId}`), {
              status: 404,
            });
          }
          const target = targetFromRegistryRecord(record);
          if (
            sourceId?.trim() &&
            sourceId.trim() !== target.alias &&
            sourceId.trim() !== dbId
          ) {
            throw Object.assign(
              new Error(`Unknown sourceId ${sourceId} for registry database ${dbId}`),
              { status: 400 },
            );
          }
          const dbPath =
            resolveExistingRegistryDbPath(record.localPath) ?? record.localPath;
          return {
            id: target.alias,
            type: "sqlite" as const,
            dbId: record.dbId,
            alias: target.alias,
            dbPath,
            tables: [],
            linkedAt: record.createdAt,
          };
        },
        query: async (appId, source, sql, params) => {
          const { withInteractiveHotPath } = await import(
            "./services/gatewayInteractivePriority.js"
          );
          const result = await withInteractiveHotPath("mini-app:db-query", () =>
            dbRouter.query(appId, source, sql, params),
          );
          return { rows: result.rows, count: result.count };
        },
        write: async (appId, source, sql, params) => {
          const { writeLinkedDbRowLocalFirst } = await import(
            "./services/syncV3/localFirstDbWrite.js"
          );
          const result = await writeLinkedDbRowLocalFirst(
            dbPool,
            dbRouter,
            appId,
            source,
            sql,
            params,
          );
          return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          };
        },
      }),
    );

    lapRouteRegistrationSection("backend-db-proxy");

    // ── App Files API (large blobs → GCS, pointer rows in the app DB) ───────
    // Apps call: fetch('/api/files/upload', { body: { appId, filePath } }).
    // Bytes never go through git — repoHygiene rejects anything over 25 MB, so
    // this is where large assets belong.
    // ─────────────────────────────────────────────────────────────────────────
    registerAppFilesRoutes(app, {
      resolveSource: (appId, sourceId, sql, operation) =>
        resolveLinkedSource(appId, sourceId, sql, operation),
      dbQuery: (appId, source, sql, params) =>
        dbRouter.query(appId, source as never, sql, params) as never,
      dbWrite: (appId, source, sql, params) =>
        dbRouter.write(appId, source as never, sql, params) as never,
      // Lets App Files choose a home when the caller named no sourceId.
      // Ids are returned rather than aliases because aliases are not unique —
      // a duplicated job link yields two sources sharing one alias.
      listSources: async (appId) => {
        const config = await getAppService().getDataSourcesConfig(appId);
        return config.sources.map((source) => ({
          id: source.id,
          alias: source.alias,
        }));
      },
    });

    lapRouteRegistrationSection("app-files-api");

    // ── Mini-app SQLite DDL API ──────────────────────────────────────────────
    // Apps call: fetch('/api/db/exec', { method: 'POST', body: JSON.stringify({ appId, sql }) })
    // Only CREATE TABLE IF NOT EXISTS is allowed (safe schema bootstrapping).
    //
    // Turso push: same as /api/db/write — TursoLinkedDbWatcher only.
    // ─────────────────────────────────────────────────────────────────────────
    app.post("/api/db/exec", async (req, res) => {
      try {
        const { appId: bodyAppId, sourceId, sql } = req.body as {
          appId?: string;
          sourceId?: string;
          sql?: string;
        };

        if (!sql) {
          res.status(400).json({ error: "sql is required" });
          return;
        }

        const resolved = resolveRequestAppId(req, bodyAppId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const appId = resolved.appId;

        const trimmed = sql.trim().toLowerCase();
        if (!trimmed.startsWith("create table if not exists")) {
          res.status(403).json({
            error:
              "Only CREATE TABLE IF NOT EXISTS is allowed on /api/db/exec.",
          });
          return;
        }

        let source: import("./services/appDataSources.js").AppDataSource;
        try {
          source = await resolveLinkedSource(appId, sourceId, sql, "write");
        } catch (err) {
          const e = err as Error & { status?: number };
          res.status(e.status ?? 400).json({ error: e.message });
          return;
        }

        const { execLinkedDbSchemaLocalFirst } = await import(
          "./services/syncV3/localFirstDbWrite.js"
        );
        await execLinkedDbSchemaLocalFirst(dbPool, dbRouter, appId, source, sql);
        console.log(
          `[Gateway] /api/db/exec app=${appId} source=${source.alias}`,
        );
        res.json({ success: true });
      } catch (err) {
        const e = err as Error & { status?: number };
        console.error("[Gateway] /api/db/exec error:", err);
        res.status(e.status ?? 500).json({ error: e.message });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    lapRouteRegistrationSection("mini-app-ddl-api");

    // ── Mini-app Jobs API ─────────────────────────────────────────────────────
    // Gives mini-apps the same job-triggering capability that agents have via
    // the run_job tool.  All endpoints are same-origin (localhost:18789) so no
    // CORS issues and no auth token is required.
    //
    //  GET  /api/jobs/list              → list all jobs (id, name, status, type)
    //  GET  /api/jobs/status/:jobId     → get current status of one job
    //  POST /api/jobs/run               → trigger a job
    //    body: { jobId: string, wait?: boolean }
    //    wait=false (default): fires immediately, returns { jobId, status:"running" }
    //    wait=true:            blocks until job finishes, returns { jobId, status, completedAt, lastOutput }
    // ─────────────────────────────────────────────────────────────────────────

    app.get("/api/jobs/list", async (_req, res) => {
      try {
        const jobsService = getJobsService();
        const jobs = await jobsService.listJobs();
        const summary = jobs.map((j) => ({
          id: j.id,
          name: j.name,
          type: j.type,
          status: j.status,
          lastRunAt: j.lastRunAt,
          completedAt: j.completedAt,
        }));
        res.json({ jobs: summary, count: summary.length });
      } catch (err) {
        console.error("[Gateway] /api/jobs/list error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/jobs/status/:jobId", async (req, res) => {
      try {
        const { jobId } = req.params;
        const jobsService = getJobsService();
        const job = await jobsService.getJob(jobId);
        if (!job) {
          res.status(404).json({ error: `Job not found: ${jobId}` });
          return;
        }
        res.json({
          id: job.id,
          name: job.name,
          type: job.type,
          status: job.status,
          lastRunAt: job.lastRunAt,
          completedAt: job.completedAt,
          error: job.error,
          lastOutput: job.lastOutput,
        });
      } catch (err) {
        console.error("[Gateway] /api/jobs/status error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/jobs/run", async (req, res) => {
      try {
        const { jobId, wait, params } = req.body as {
          jobId?: string;
          wait?: boolean;
          /** Runtime env vars passed to the job process, e.g. { THREAD_ID: "abc123" } */
          params?: Record<string, string>;
        };
        if (!jobId) {
          res.status(400).json({ error: "jobId is required" });
          return;
        }
        // Validate params: keys and values must be strings
        if (params !== undefined) {
          if (typeof params !== "object" || Array.isArray(params)) {
            res.status(400).json({
              error: "params must be a flat object of string key-value pairs",
            });
            return;
          }
          for (const [k, v] of Object.entries(params)) {
            if (typeof k !== "string" || typeof v !== "string") {
              res.status(400).json({
                error: `params values must be strings (got ${typeof v} for key "${k}")`,
              });
              return;
            }
          }
        }
        const { mergeVerifiedCallerJobParams } = await import(
          "./services/appRuntime/miniAppAccess.js"
        );
        const { getPaprCallerIdentity } = await import("./utils/paprUserId.js");
        const verifiedParams = mergeVerifiedCallerJobParams(params, true, getPaprCallerIdentity());
        const jobsService = getJobsService();
        const job = await jobsService.getJob(jobId);
        if (!job) {
          res.status(404).json({ error: `Job not found: ${jobId}` });
          return;
        }
        if (wait) {
          try {
            const result = await jobsService.runJob(jobId, verifiedParams);
            res.json({
              jobId,
              status: result.status,
              completedAt: result.completedAt,
              error: result.error,
              lastOutput: result.lastOutput,
            });
          } catch (runErr: unknown) {
            if (isExpectedJobRunCollision(runErr)) {
              const snapshot = await jobsService.getJob(jobId);
              const reason = runErr instanceof JobsService.DependencyRunningError
                ? "dependency_running"
                : "already_running";
              res.status(409).json({
                jobId,
                status: snapshot?.status ?? "pending",
                error:
                  runErr instanceof Error ? runErr.message : String(runErr),
                reason,
                ...(runErr instanceof JobsService.DependencyRunningError
                  ? { dependencyId: runErr.dependencyId }
                  : {}),
              });
              return;
            }
            throw runErr;
          }
        } else {
          try {
            const started = await jobsService.startJobRunForApi(
              jobId,
              verifiedParams,
            );
            if (started.status === "failed") {
              res.status(503).json({
                jobId: started.jobId,
                status: "failed",
                error: started.error ?? "Job failed to start",
              });
              return;
            }
            res.json({ jobId: started.jobId, status: started.status });
          } catch (runErr: unknown) {
            if (isExpectedJobRunCollision(runErr)) {
              const snapshot = await jobsService.getJob(jobId);
              const reason =
                runErr instanceof JobsService.DependencyRunningError
                  ? "dependency_running"
                  : "already_running";
              res.status(409).json({
                jobId,
                status: snapshot?.status ?? "pending",
                error:
                  runErr instanceof Error ? runErr.message : String(runErr),
                reason,
                ...(runErr instanceof JobsService.DependencyRunningError
                  ? { dependencyId: runErr.dependencyId }
                  : {}),
              });
              return;
            }
            throw runErr;
          }
        }
      } catch (err) {
        console.error("[Gateway] /api/jobs/run error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Explicit escape hatch for a phantom `running` flag (no tracked process
    // after a failed spawn). Refuses when the job is genuinely running.
    app.post("/api/jobs/clear-stale", async (req, res) => {
      try {
        const { jobId } = req.body as { jobId?: string };
        if (!jobId) {
          res.status(400).json({ error: "jobId is required" });
          return;
        }
        const jobsService = getJobsService();
        const job = await jobsService.getJob(jobId);
        if (!job) {
          res.status(404).json({ error: `Job not found: ${jobId}` });
          return;
        }
        const cleared = await jobsService.clearStaleRunningState(jobId);
        const snapshot = await jobsService.getJob(jobId);
        res.status(cleared ? 200 : 409).json({
          jobId,
          cleared,
          status: snapshot?.status ?? job.status,
          ...(cleared
            ? {}
            : {
                reason:
                  job.status === "running"
                    ? "job has an active process or agent run"
                    : `job is not running (status: ${job.status})`,
              }),
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    registerPaprMiniAppSdkRoutes(app);

    app.get("/api/access", async (req, res) => {
      try {
        const explicitAppId = req.query["appId"] as string | undefined;
        const resolved = resolveRequestAppId(req, explicitAppId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const { buildLocalDesktopAccessResponse } = await import(
          "./services/appRuntime/miniAppAccess.js"
        );
        const { getPaprCallerIdentity } = await import("./utils/paprUserId.js");
        res.json(buildLocalDesktopAccessResponse(resolved.appId, getPaprCallerIdentity()));
      } catch (err) {
        console.error("[Gateway] /api/access error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/members", async (req, res) => {
      try {
        const explicitAppId = req.query["appId"] as string | undefined;
        const resolved = resolveRequestAppId(req, explicitAppId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        void resolved;

        const { getApiKey } = await import("./utils/keyResolver.js");
        const { getPaprWorkspaceId, getGatewayPaprProfile } = await import(
          "./utils/paprGatewayProfile.js"
        );
        const { readActiveWorkspacePointer } = await import(
          "../core/utils/paprWorkspace.js"
        );
        const {
          listMiniAppMembers,
        } = await import("./services/appRuntime/miniAppMembers.js");

        const sessionToken = await getApiKey("PAPR_SESSION_TOKEN");
        if (!sessionToken) {
          res.status(401).json({
            error: "Sign in with Papr to list workspace members.",
          });
          return;
        }

        const workspaceId = getPaprWorkspaceId();
        if (!workspaceId) {
          res.status(503).json({
            error:
              "No Papr workspace id is available. Sign out and sign in again to refresh workspace metadata.",
          });
          return;
        }

        const pointer = readActiveWorkspacePointer();
        const profile = getGatewayPaprProfile();
        const namespaceId =
          process.env.PAPR_NAMESPACE_ID?.trim() || pointer?.namespaceId;

        const result = await listMiniAppMembers({
          sessionToken,
          workspaceId,
          workspaceName: profile.paprWorkspaceName,
          namespaceId,
        });
        res.json(result);
      } catch (err) {
        if (
          err instanceof Error &&
          err.name === "MiniAppMembersError" &&
          "status" in err &&
          typeof err.status === "number"
        ) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        console.error("[Gateway] /api/members error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    registerAppAgentChatRoutes(app, {
      mode: "desktop",
      sessionStore: getFileAppAgentChatSessionStore(),
      getDesktopApp: async (appId) => {
        const appService = getAppService();
        await appService.initialize();
        return appService.getApp(appId);
      },
    });

    registerJobEventsSseRoutes(app, {
      hub: getJobEventHub(),
      onDbIdsSubscribe: (dbIds) => {
        void import("./services/tursoPullScheduler.js").then(
          ({ scheduleTursoPullForDbIds }) => {
            scheduleTursoPullForDbIds(dbIds);
          },
        );
      },
      pollJobStatus: async (jobId, _req) => {
        const job = await getJobsService().getJob(jobId);
        if (!job) {
          return null;
        }
        return {
          jobId: job.id,
          name: job.name,
          status: job.status,
          completedAt: job.completedAt,
          error: job.error,
          lastOutput: job.lastOutput,
        };
      },
    });

    lapRouteRegistrationSection("mini-app-jobs-api");

    // ── Mini-app Job Creation API ─────────────────────────────────────────────
    // Lets mini-apps programmatically create jobs (the same capability agents have
    // via the create_job tool). Intended for dynamic automation workflows where
    // mini-apps generate job pipelines based on user configuration in the UI.
    //
    // Security:
    //  - Rate limited to 10 jobs per minute per app (prevents spam)
    //  - Command size capped at 100KB (prevents abuse)
    //  - All validation from create_job tool applies (Zod schemas)
    //  - No privilege escalation (mini-apps already have bash access via /api/bash/run)
    //
    //  POST /api/jobs/create
    //    body: CreateJobInput (same as create_job tool)
    //    returns: { success: true, jobId: string } or { error: string }
    // ─────────────────────────────────────────────────────────────────────────

    // Rate limiter for job creation (per app ID)
    const jobCreationRateLimit = new Map<
      string,
      { count: number; windowStart: number }
    >();
    const MAX_JOBS_PER_MINUTE = 10;
    const RATE_LIMIT_WINDOW_MS = 60_000;

    app.post("/api/jobs/create", async (req, res) => {
      try {
        const input = req.body as CreateJobInput & { appId?: string };
        const appId = input.appId || "unknown";

        // Rate limit check
        const now = Date.now();
        const rateLimitData = jobCreationRateLimit.get(appId);

        if (rateLimitData) {
          // Reset window if expired
          if (now - rateLimitData.windowStart >= RATE_LIMIT_WINDOW_MS) {
            rateLimitData.count = 0;
            rateLimitData.windowStart = now;
          }

          // Check if limit exceeded
          if (rateLimitData.count >= MAX_JOBS_PER_MINUTE) {
            const timeRemaining = Math.ceil(
              (rateLimitData.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000,
            );
            res.status(429).json({
              error: `Rate limit exceeded. Max ${MAX_JOBS_PER_MINUTE} jobs per minute per app. Try again in ${timeRemaining}s.`,
            });
            return;
          }

          rateLimitData.count++;
        } else {
          jobCreationRateLimit.set(appId, { count: 1, windowStart: now });
        }

        // Size validation
        if (input.command && input.command.length > 100_000) {
          res.status(400).json({
            error: "Command too large. Maximum 100KB allowed.",
          });
          return;
        }

        // Create job via JobsService (all validation happens there)
        const jobsService = getJobsService();
        const createInput: CreateJobInput = {
          ...input,
          appIds:
            input.appIds?.length
              ? input.appIds
              : input.appId
                ? [input.appId]
                : [],
        };
        const job = await jobsService.createJob(createInput);

        console.log(
          `[Gateway] /api/jobs/create: App ${appId} created job ${job.id} (${job.name})`,
        );

        res.json({
          success: true,
          jobId: job.id,
          name: job.name,
          type: job.type,
          status: job.status,
        });
      } catch (err) {
        console.error("[Gateway] /api/jobs/create error:", err);
        res.status(400).json({ error: (err as Error).message });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    lapRouteRegistrationSection("mini-app-job-create-api");

    // ── Brand API (mini-apps) ─────────────────────────────────────────────────
    //  GET /api/brand?appId=...     → merged brand tokens + cssVariables
    //  GET /api/brand/assets/:file  → logo/asset from workspace or app brand/
    // ─────────────────────────────────────────────────────────────────────────

    app.get("/api/brand", async (req, res) => {
      try {
        const appId =
          typeof req.query.appId === "string" ? req.query.appId : undefined;
        const { getBrandService } = await import("./services/BrandService.js");
        const brand = await getBrandService().loadMergedBrand(appId);
        res.json(brand);
      } catch (err) {
        console.error("[Gateway] /api/brand error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/brand/assets/:filename", async (req, res) => {
      try {
        const filename = req.params.filename;
        const appId =
          typeof req.query.appId === "string" ? req.query.appId : undefined;
        const { getBrandService } = await import("./services/BrandService.js");
        const assetPath = await getBrandService().resolveAssetPath(
          filename,
          appId,
        );

        if (!assetPath) {
          res.status(404).json({ error: "Brand asset not found" });
          return;
        }

        const ext = path.extname(assetPath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
          ".gif": "image/gif",
        };
        res.setHeader(
          "Content-Type",
          mimeTypes[ext] ?? "application/octet-stream",
        );
        res.sendFile(assetPath);
      } catch (err) {
        console.error("[Gateway] /api/brand/assets error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    lapRouteRegistrationSection("brand-api");

    // ── Mini-app Bash API ─────────────────────────────────────────────────────
    // Lets mini-apps run quick shell commands (the same capability agents have
    // via the bash tool).  Intended for lightweight backend calls like resetting
    // a DB row, calling a CLI, or reading a file — not long-running processes.
    //
    // Supports custom key substitution: ${KEY_NAME} placeholders are replaced
    // with values from Settings → API Keys (via CustomKeysService).
    //
    //  POST /api/bash/run
    //    body: { command: string, timeoutMs?: number (default 30000) }
    //    returns: { stdout, stderr, exitCode }
    // ─────────────────────────────────────────────────────────────────────────

    lapRouteRegistrationSection("mini-app-bash-api");

    // ── Cloud Publish (local handlers — must register before cloud proxy) ───
    app.get("/api/cloud/publish/:appId", async (req, res) => {
      try {
        const config = await getCloudAppPublishService().getPublishConfig(
          req.params.appId,
        );
        const prefs = getAppPublishPrefs(req.params.appId);
        let compatibility: unknown = null;
        try {
          const { scanAppCloudCompatibility } = await import(
            "./services/cloudAppCompatibility.js"
          );
          compatibility = await scanAppCloudCompatibility(req.params.appId);
        } catch (compatErr) {
          console.warn(
            `[Gateway] /api/cloud/publish/${req.params.appId} compatibility scan failed:`,
            compatErr,
          );
          compatibility = {
            ok: false,
            error: (compatErr as Error).message,
          };
        }
        res.json({ ...config, prefs, compatibility });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/cloud/publish/:appId/compatibility", async (req, res) => {
      try {
        const { scanAppCloudCompatibility } = await import(
          "./services/cloudAppCompatibility.js"
        );
        const compatibility = await scanAppCloudCompatibility(req.params.appId);
        res.json(compatibility);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/cloud/publish/:appId/readiness", async (req, res) => {
      try {
        const { buildCloudPublishReadinessForApp } = await import(
          "./services/cloudAppPublishReadiness.js"
        );
        const readiness = await buildCloudPublishReadinessForApp(req.params.appId);
        res.json(readiness);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/cloud/publish/:appId", async (req, res) => {
      try {
        const body = req.body as {
          accessMode?: CloudAccessMode;
          loginAccess?: import("./services/cloudSharingSettings.js").CloudLoginAccess;
          externalLink?: import("./services/cloudSharingSettings.js").CloudExternalLink;
          codeAccess?: import("../core/utils/shareAudienceModel.js").CodeAccess;
          requireSignIn?: boolean;
          perUserIsolation?: boolean;
          // Audience "people". First publish of a restricted app goes through
          // POST (not PATCH), so omitting it here silently published the app
          // to the whole workspace.
          allowedUserIds?: string[];
          allowedEmails?: string[];
          allowedEmailDomains?: string[];
          slug?: string;
          autoPublish?: boolean;
          acknowledgeDesktopOnly?: boolean;
        };
        const { scanAppCloudCompatibility } = await import(
          "./services/cloudAppCompatibility.js"
        );
        const compatibility = await scanAppCloudCompatibility(req.params.appId);
        if (
          compatibility.requiresAcknowledgement &&
          body.acknowledgeDesktopOnly !== true
        ) {
          res.status(409).json({
            error:
              "This app uses desktop-only features (paprAPI, local Chrome, or localhost gateway). Confirm to publish anyway.",
            compatibility,
          });
          return;
        }
        if (body.autoPublish !== undefined) {
          setAppPublishPrefs(req.params.appId, { autoPublish: body.autoPublish });
        }
        if (
          body.accessMode ||
          body.loginAccess !== undefined ||
          body.externalLink !== undefined ||
          body.codeAccess !== undefined ||
          body.requireSignIn !== undefined ||
          body.perUserIsolation !== undefined ||
          body.allowedUserIds !== undefined ||
          body.allowedEmails !== undefined ||
          body.allowedEmailDomains !== undefined
        ) {
          setAppPublishPrefs(req.params.appId, {
            ...(body.accessMode ? { accessMode: body.accessMode } : {}),
            ...(body.loginAccess !== undefined
              ? { loginAccess: body.loginAccess }
              : {}),
            ...(body.externalLink !== undefined
              ? { externalLink: body.externalLink }
              : {}),
            ...(body.codeAccess !== undefined
              ? { codeAccess: body.codeAccess }
              : {}),
            ...(body.requireSignIn !== undefined
              ? { requireSignIn: body.requireSignIn }
              : {}),
            ...(body.perUserIsolation !== undefined
              ? { perUserIsolation: body.perUserIsolation }
              : {}),
            ...(body.allowedUserIds !== undefined
              ? { allowedUserIds: body.allowedUserIds }
              : {}),
            ...(body.allowedEmails !== undefined
              ? { allowedEmails: body.allowedEmails }
              : {}),
            ...(body.allowedEmailDomains !== undefined
              ? { allowedEmailDomains: body.allowedEmailDomains }
              : {}),
          });
        }
        const config = await getCloudAppPublishService().publishOrUpdateSharing(
          req.params.appId,
          {
            accessMode: body.accessMode,
            loginAccess: body.loginAccess,
            externalLink: body.externalLink,
            codeAccess: body.codeAccess,
            requireSignIn: body.requireSignIn,
            perUserIsolation: body.perUserIsolation,
            slug: body.slug,
          },
        );
        invalidateCloudLinkSyncReportCache();
        res.json({
          ...config,
          prefs: getAppPublishPrefs(req.params.appId),
          compatibility,
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.delete("/api/cloud/publish/:appId", async (req, res) => {
      try {
        await getCloudAppPublishService().unpublishApp(req.params.appId);
        setAppPublishPrefs(req.params.appId, { autoPublish: false });
        invalidateCloudLinkSyncReportCache();
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.patch("/api/cloud/publish/:appId/prefs", async (req, res) => {
      try {
        const body = req.body as {
          autoPublish?: boolean;
          uploadMode?: import("./services/cloudPublishPrefs.js").CloudUploadModePref;
          cloudEnabled?: import("./services/cloudPublishPrefs.js").CloudEnabledPref;
          accessMode?: CloudAccessMode;
          loginAccess?: import("./services/cloudSharingSettings.js").CloudLoginAccess;
          externalLink?: import("./services/cloudSharingSettings.js").CloudExternalLink;
          codeAccess?: import("../core/utils/shareAudienceModel.js").CodeAccess;
          requireSignIn?: boolean;
          perUserIsolation?: boolean;
          // Audience "people". Intentionally not part of
          // prefsSharingFieldsChanged: the cloud ACL stays "team" either way,
          // so there is nothing for the memory server to update — the
          // allowlist is enforced by the gateway on each request.
          allowedUserIds?: string[];
          allowedEmails?: string[];
          allowedEmailDomains?: string[];
        };
        const prefs = setAppPublishPrefs(req.params.appId, body);
        invalidateCloudLinkSyncReportCache();
        if (prefsSharingFieldsChanged(body)) {
          const config = await getCloudAppPublishService().updateSharing(
            req.params.appId,
            {
              accessMode: body.accessMode,
              loginAccess: body.loginAccess,
              externalLink: body.externalLink,
              codeAccess: body.codeAccess,
              requireSignIn: body.requireSignIn,
              perUserIsolation: body.perUserIsolation,
            },
          );
          res.json({ prefs, ...(config ? { config } : {}) });
          return;
        }
        res.json({ prefs });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/cloud/lineage", async (_req, res) => {
      try {
        const index = await getCloudAppLineageService().buildIndex();
        res.json(index);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/cloud/install", async (req, res) => {
      try {
        const body = req.body as {
          namespaceId: string;
          slug: string;
          mode?: "fork" | "track";
          shareToken?: string;
          catalogScope?: "global" | "namespace" | "community" | "team";
          visibility?: string;
          codeInstallable?: boolean;
          title?: string;
        };
        if (!body.namespaceId || !body.slug) {
          res.status(400).json({ error: "namespaceId and slug are required" });
          return;
        }
        const result = await runCloudCatalogInstall(body);
        res.json(result);
      } catch (err) {
        const message = (err as Error).message;
        const code =
          err instanceof Error && "code" in err
            ? String((err as { code?: string }).code)
            : undefined;
        if (err instanceof CloudCatalogInstallChoiceRequiredError) {
          res.status(400).json({
            error: message,
            code: err.code,
            catalogScope: err.catalogScope,
            namespaceId: err.namespaceId,
            slug: err.slug,
            visibility: err.visibility,
            options: err.options,
          });
          return;
        }
        const status =
          code === "community_track_forbidden" ||
          code === "non_team_track_forbidden" ||
          code === "per_user_db" ||
          code === "install_mode_choice_required"
            ? 400
            : 500;
        res.status(status).json({ error: message, ...(code ? { code } : {}) });
      }
    });

    app.post("/api/cloud/apps/:appId/bootstrap-databases", async (req, res) => {
      try {
        const appId = req.params.appId?.trim();
        if (!appId) {
          res.status(400).json({ error: "appId is required" });
          return;
        }
        const { finalizePortableCloudAppResources } = await import(
          "./services/cloudAppLinkedResourcesInstall.js"
        );
        await finalizePortableCloudAppResources();
        const { bootstrapInstalledAppDatabases, buildCloudInstallAgentSetupMessage } =
          await import("./services/cloudAppInstallBootstrap.js");
        const bootstrap = await bootstrapInstalledAppDatabases(appId);
        const appService = getAppService();
        const app = await appService.getApp(appId);
        const agentSetupMessage =
          bootstrap.errors.length > 0 ||
          !bootstrap.ready ||
          bootstrap.needsSeed ||
          bootstrap.warnings.length > 0
            ? buildCloudInstallAgentSetupMessage({
                appTitle: app?.title ?? appId,
                appId,
                bootstrap,
              })
            : undefined;
        res.json({ bootstrap, agentSetupMessage });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/cloud/apps/:appId/requirements", async (req, res) => {
      try {
        const paprDir = getPaprRoot();
        const discovery = await discoverAppRequirements(paprDir, req.params.appId);
        res.json(discovery);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.put("/api/cloud/apps/:appId/requirements", async (req, res) => {
      try {
        const body = req.body as { requirements?: unknown };
        if (!Array.isArray(body.requirements)) {
          res.status(400).json({ error: "requirements array is required" });
          return;
        }
        const paprDir = getPaprRoot();
        const file = writeAppRequirements(
          paprDir,
          req.params.appId,
          body.requirements as RequiredKeySpec[],
        );
        res.json({ requirements: file.requirements, updatedAt: file.updatedAt });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/cloud/track-sync/pull-on-publish", async (_req, res) => {
      try {
        const results =
          await getCloudAppTrackSyncService().pullTrackAppsOnPublish();
        res.json({ results });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/cloud/track-sync", async (_req, res) => {
      try {
        const results = await getCloudAppTrackSyncService().syncAllTrackApps();
        res.json({ results });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/cloud/track-sync/:appId/local-edits", async (req, res) => {
      try {
        const result = await getCloudAppTrackSyncService().localEdits(
          req.params.appId,
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/cloud/track-sync/:appId", async (req, res) => {
      try {
        const discardLocal =
          (req.body as { discardLocal?: boolean } | undefined)?.discardLocal === true;
        const result = await getCloudAppTrackSyncService().syncTrackApp(
          req.params.appId,
          { discardLocal },
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/cloud/apps/changes", async (req, res) => {
      try {
        const paprApiKey = await getPaprApiKey();
        if (!paprApiKey) {
          res.status(401).json({ error: "PAPR_API_KEY not configured. Login with Papr first." });
          return;
        }

        const body = req.body as {
          sourceNamespaceId?: string;
          sourceSlug?: string;
          installedAppId?: string;
          title?: string;
          description?: string;
        };
        if (
          !body.sourceNamespaceId?.trim() ||
          !body.sourceSlug?.trim() ||
          !body.installedAppId?.trim() ||
          !body.title?.trim() ||
          !body.description?.trim()
        ) {
          res.status(400).json({ error: "Missing required contribute-back fields" });
          return;
        }

        const result = await getCloudAppContributeService().propose({
          sourceNamespaceId: body.sourceNamespaceId.trim(),
          sourceSlug: body.sourceSlug.trim(),
          installedAppId: body.installedAppId.trim(),
          title: body.title.trim(),
          description: body.description.trim(),
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Proposals this user sent, optionally for one installed copy. Used by the
    // Propose sheet to show status (waiting / accepted / declined).
    app.get("/api/cloud/apps/changes/outgoing", async (req, res) => {
      try {
        const paprApiKey = await getPaprApiKey();
        if (!paprApiKey) {
          res.status(401).json({ error: "PAPR_API_KEY not configured. Login with Papr first." });
          return;
        }
        const installedAppId =
          typeof req.query.installedAppId === "string" ? req.query.installedAppId.trim() : "";
        const query = installedAppId ? `?installedAppId=${encodeURIComponent(installedAppId)}` : "";
        const { cloudApiFetch } = await import("./utils/cloudApiClient.js");
        const upstream = await cloudApiFetch(`/v1/cloud/apps/changes/outgoing${query}`);
        const bodyText = await upstream.text();
        if (!upstream.ok) {
          // Older memory servers have no outgoing route: show no history.
          if (upstream.status === 404 || upstream.status === 405) {
            res.json({ requests: [] });
            return;
          }
          res.status(upstream.status).json({ error: bodyText.slice(0, 240) });
          return;
        }
        res.status(200).type("application/json").send(bodyText);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get("/api/cloud/apps/changes/incoming", async (req, res) => {
      try {
        const paprApiKey = await getPaprApiKey();
        if (!paprApiKey) {
          res.status(401).json({
            error: "PAPR_API_KEY not configured. Login with Papr first.",
          });
          return;
        }

        const statusParam =
          typeof req.query.status === "string" ? req.query.status.trim() : "";
        const query = statusParam
          ? `?status=${encodeURIComponent(statusParam)}`
          : "";
        const { cloudApiFetch } = await import("./utils/cloudApiClient.js");
        const upstream = await cloudApiFetch(
          `/v1/cloud/apps/changes/incoming${query}`,
        );
        const bodyText = await upstream.text();
        if (!upstream.ok) {
          let message = bodyText.slice(0, 240);
          try {
            const parsed = JSON.parse(bodyText) as {
              error?: string;
              detail?: string;
              message?: string;
            };
            message =
              parsed.error ?? parsed.detail ?? parsed.message ?? message;
          } catch {
            /* keep raw slice */
          }
          res.status(upstream.status).json({ error: message });
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(bodyText) as unknown;
        } catch {
          res.status(200);
          const contentType = upstream.headers.get("content-type");
          if (contentType) {
            res.setHeader("Content-Type", contentType);
          }
          res.send(bodyText);
          return;
        }

        const { enrichIncomingChangeRequestsBody } = await import(
          "./services/changeRequestContributorEnrich.js"
        );
        const enriched = await enrichIncomingChangeRequestsBody(payload);
        res.status(200).json(enriched);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/cloud/apps/changes/:requestId/approve", async (req, res) => {
      try {
        const paprApiKey = await getPaprApiKey();
        if (!paprApiKey) {
          res.status(401).json({ error: "PAPR_API_KEY not configured. Login with Papr first." });
          return;
        }

        const memoryServerBase = getMemoryServerBaseUrl();
        const { appendCloudActingUserQuery } = await import("./utils/cloudActingUser.js");
        const targetUrl = `${memoryServerBase}${appendCloudActingUserQuery(
          `/v1/cloud/apps/changes/${encodeURIComponent(req.params.requestId)}/approve`,
        )}`;
        const upstream = await fetch(targetUrl, {
          method: "POST",
          headers: {
            "X-API-Key": paprApiKey,
            "Content-Type": "application/json",
          },
        });
        const bodyText = await upstream.text();

        if (!upstream.ok) {
          res.status(upstream.status);
          const ct = upstream.headers.get("content-type");
          if (ct) res.setHeader("Content-Type", ct);
          res.send(bodyText);
          return;
        }

        const parsed = bodyText
          ? (JSON.parse(bodyText) as Record<string, unknown>)
          : {};
        const { readSourceAppIdFromApproveBody, followUpContributeApprove } =
          await import("./services/contributeApproveFollowUp.js");
        const sourceAppId = readSourceAppIdFromApproveBody(parsed);
        const pullResult = await followUpContributeApprove(sourceAppId);

        res.json({ ...parsed, pull: pullResult, sourceAppId });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    lapRouteRegistrationSection("cloud-publish-routes");

    // ── Cloud Proxy ──────────────────────────────────────────────────────────
    // Proxy /api/cloud/* → Memory Server /v1/cloud/*
    // Attaches user's PAPR_API_KEY from keychain automatically.
    // ─────────────────────────────────────────────────────────────────────────
    const cloudProxyHandler: import("express").RequestHandler = async (req, res) => {
      try {
        const paprApiKey = await getPaprApiKey();
        if (!paprApiKey) {
          res.status(401).json({ error: "PAPR_API_KEY not configured. Login with Papr first." });
          return;
        }

        const memoryServerBase = getMemoryServerBaseUrl();

        const cloudPath = req.originalUrl.replace(/^\/api\/cloud/, "/v1/cloud");
        const { appendCloudActingUserQuery, mergeCloudActingUserBody } = await import(
          "./utils/cloudActingUser.js"
        );

        const headers: Record<string, string> = {
          "X-API-Key": paprApiKey,
          "Content-Type": "application/json",
        };

        const isVaultSync = cloudPath.includes("/vault/sync");
        const isReposInit = cloudPath.includes("/repos/init");
        const isRuntimeJobRun = cloudPath.includes("/runtime/job-run");
        let proxyTimeoutMs: number;
        if (isVaultSync) {
          const { resolveVaultPushTimeoutMs } = await import(
            "./services/vaultSyncBackgroundPush.js"
          );
          proxyTimeoutMs = resolveVaultPushTimeoutMs();
        } else if (isRuntimeJobRun) {
          proxyTimeoutMs = 930_000;
        } else if (isReposInit) {
          proxyTimeoutMs = 60_000;
        } else {
          proxyTimeoutMs = 30_000;
        }
        const proxyController = new AbortController();
        const proxyTimer = setTimeout(() => proxyController.abort(), proxyTimeoutMs);

        const fetchOpts: RequestInit = {
          method: req.method,
          headers,
          signal: proxyController.signal,
        };
        let proxiedPath = cloudPath;
        if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
          const payload =
            typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
              ? mergeCloudActingUserBody(req.body as Record<string, unknown>)
              : req.body;
          fetchOpts.body = JSON.stringify(payload);
        } else {
          proxiedPath = appendCloudActingUserQuery(cloudPath);
        }

        const targetUrl = `${memoryServerBase}${proxiedPath}`;
        console.log(`[Gateway] Cloud proxy: ${req.method} ${proxiedPath} → ${memoryServerBase}`);

        const upstream = await fetch(targetUrl, fetchOpts);
        clearTimeout(proxyTimer);
        const body = await upstream.text();

        if (isVaultSync) {
          const {
            recordVaultSyncPlatformFailure,
            recordVaultSyncPlatformSuccess,
          } = await import("./services/vaultSyncPlatformBackoff.js");
          if (upstream.ok) {
            recordVaultSyncPlatformSuccess();
          } else if (upstream.status >= 500) {
            recordVaultSyncPlatformFailure(upstream.status, body);
          }
        }

        res.status(upstream.status);
        const ct = upstream.headers.get("content-type");
        if (ct) res.setHeader("Content-Type", ct);
        res.send(body);
      } catch (err) {
        console.error("[Gateway] Cloud proxy error:", err);
        res.status(502).json({ error: `Cloud proxy failed: ${(err as Error).message}` });
      }
    };

    const cloudPathRegex = /^\/api\/cloud\/(.*)/;
    app.get(cloudPathRegex, cloudProxyHandler);
    app.post(cloudPathRegex, cloudProxyHandler);
    app.put(cloudPathRegex, cloudProxyHandler);
    app.delete(cloudPathRegex, cloudProxyHandler);

    lapRouteRegistrationSection("cloud-proxy");

    // ── Cloud Sync Status + Triggers ─────────────────────────────────────
    app.get("/api/sync/status", (_req, res) => {
      const sync = getCloudSyncService();
      if (!sync) {
        res.json({ enabled: false, reason: "Cloud sync not initialized" });
        return;
      }
      res.json({ enabled: true, ...sync.getState() });
    });

    app.post("/api/workspace/switch", async (req, res) => {
      if (!isLoopbackRequest(req)) {
        res.status(403).json({
          success: false,
          error: "Workspace control endpoints are localhost-only",
        });
        return;
      }
      try {
        const organizationId =
          typeof req.body?.organizationId === "string"
            ? req.body.organizationId.trim()
            : "";
        const namespaceId =
          typeof req.body?.namespaceId === "string"
            ? req.body.namespaceId.trim()
            : "";
        if (!organizationId || !namespaceId) {
          res.status(400).json({
            success: false,
            error: "organizationId and namespaceId are required",
          });
          return;
        }

        const result = await switchActiveWorkspace({
          organizationId,
          namespaceId,
          organizationName:
            typeof req.body?.organizationName === "string"
              ? req.body.organizationName
              : undefined,
          namespaceName:
            typeof req.body?.namespaceName === "string"
              ? req.body.namespaceName
              : undefined,
          paprApiKey:
            typeof req.body?.paprApiKey === "string"
              ? req.body.paprApiKey
              : undefined,
          skipLegacyMigration: req.body?.skipLegacyMigration === true,
          runPostMigrationPathRepair:
            req.body?.runPostMigrationPathRepair === true,
        });
        res.json(result);
      } catch (error) {
        const { WorkspaceSwitchApiKeyError: ApiKeyError } = await import(
          "./services/workspaceSwitchService.js"
        );
        const status = error instanceof ApiKeyError ? 400 : 500;
        res.status(status).json({
          success: false,
          error: error instanceof Error ? error.message : "Workspace switch failed",
        });
      }
    });

    app.post("/api/workspace/papr-api-key", async (req, res) => {
      if (!isLoopbackRequest(req)) {
        res.status(403).json({
          success: false,
          error: "Workspace control endpoints are localhost-only",
        });
        return;
      }
      const paprApiKey =
        typeof req.body?.paprApiKey === "string"
          ? req.body.paprApiKey.trim()
          : "";
      if (!paprApiKey) {
        res.status(400).json({ success: false, error: "paprApiKey is required" });
        return;
      }
      try {
        await applyGatewayPaprApiKey(paprApiKey);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to apply Papr API key",
        });
      }
    });

    // Structured view of IDENTITY.md → ## Goals for the Home app (read-only;
    // goals are edited through chat so the agent keeps IDENTITY.md canonical).
    app.get("/api/workspace/goals", async (_req, res) => {
      try {
        const { readWorkspaceGoals } = await import(
          "./services/workspaceGoals.js"
        );
        res.json(await readWorkspaceGoals());
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Lazy first-run setup for the bundled Home dashboard (job + DB + data-sources).
    app.post("/api/home/ensure-brief-setup", async (req, res) => {
      try {
        const { appId: bodyAppId } = (req.body ?? {}) as { appId?: string };
        const { DEFAULT_HOME_APP_ID } = await import(
          "./services/defaultHomeBundle.js"
        );
        const appId = bodyAppId?.trim() || DEFAULT_HOME_APP_ID;
        const result = await getAppService().ensureHomeDailyBriefReady(appId);
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes("not found") ? 404 : 500;
        res.status(status).json({ error: message });
      }
    });

    // Unified tasks (L3 goals + entity Open Items), projected into the Home DB.
    app.get("/api/workspace/tasks", async (req, res) => {
      try {
        const status = typeof req.query.status === "string" ? req.query.status : "open";
        const { readWorkspaceTasks } = await import("./services/workspaceTasks.js");
        res.json(await readWorkspaceTasks({ status }));
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    // Complete / reopen a task: edits the source markdown (entity Open Item
    // checkbox or L3 goal block), then re-projects. One check → every agent sees it.
    app.post("/api/workspace/tasks/:taskId/done", async (req, res) => {
      try {
        const body = (req.body ?? {}) as { done?: boolean; outcome?: string };
        const { setTaskDone } = await import("./services/workspaceTasks.js");
        const result = await setTaskDone(String(req.params.taskId), body.done !== false, body.outcome);
        res.status(result.ok ? 200 : 404).json(result);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    // Re-project IDENTITY.md goals + entity Open Items into the Home DB now
    // (agents call this after editing goals in chat; Sleep/Wiki trigger it on completion).
    app.post("/api/workspace/project", async (_req, res) => {
      try {
        const { projectGoalsAndTasks } = await import("./services/goalsTasksProjection.js");
        res.json(await projectGoalsAndTasks("api"));
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.get("/api/workspace/active", (_req, res) => {
      const pointer = readActiveWorkspacePointer();
      if (!pointer) {
        res.json({ active: false });
        return;
      }
      res.json({ active: true, pointer });
    });

    app.get("/api/workspace/switch-status", (_req, res) => {
      res.json(getWorkspaceSwitchStatus());
    });

    app.get("/api/sync/items", async (req, res) => {
      const sync = getCloudSyncService();
      if (!sync) {
        res.json({
          enabled: false,
          reason: "Cloud sync not initialized",
          github: null,
          turso: null,
        });
        return;
      }

      const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
      const appId =
        typeof req.query.appId === "string" && req.query.appId.trim().length > 0
          ? req.query.appId.trim()
          : undefined;

      const timer = createSyncItemsRouteTimer();
      let tursoFromCache = false;
      let responseFromCache = false;

      if (appId && !forceRefresh) {
        const cachedPayload = getCachedSyncItemsAppResponse(appId);
        if (cachedPayload) {
          responseFromCache = true;
          timer.mark("appResponseCache");
          res.json(cachedPayload);
          logSyncItemsRoute(timer, {
            appId,
            forceRefresh,
            tursoCached: cachedPayload.tursoCached === true,
            responseCached: true,
          });
          return;
        }
      }

      try {
        const { yieldToInteractiveHotPath } = await import(
          "./services/gatewayBackgroundWork.js"
        );
        await yieldToInteractiveHotPath("api:sync/items", {
          minQuietMs: 300,
          maxWaitMs: 45_000,
        });

        let appContext:
          | {
              appId: string;
              dependentJobIds: string[];
              registryDbIds: string[];
              globalAutoUploadEnabled: boolean;
              publishLive: boolean;
              publishedAt: string | null;
            }
          | undefined;
        if (appId) {
          const {
            resolveAppDependentJobIds,
            readDataSourceRegistryDbIds,
          } = await import("./services/cloudSync/resolveAppDependentJobs.js");
          const { isCloudAutoUploadGloballyEnabled } = await import(
            "./services/cloudUploadMode.js"
          );
          if (forceRefresh) {
            await sync.reconcileAppDependentPathsIfNeeded(appId);
            timer.mark("reconcileIfNeeded");
          }
          let publishLive = false;
          let publishedAt: string | null = null;
          try {
            const { getCloudAppPublishService } = await import(
              "./services/CloudAppPublishService.js"
            );
            const publishService = getCloudAppPublishService();
            if (publishService) {
              const cfg = await publishService.getPublishConfig(appId);
              publishLive = cfg.enabled === true && !!cfg.shareUrl;
              publishedAt = cfg.publishedAt;
            }
          } catch {
            /* publish lookup optional for sync status */
          }
          timer.mark("publishConfig");
          appContext = {
            appId,
            dependentJobIds: resolveAppDependentJobIds(
              getPaprRoot(),
              appId,
            ),
            registryDbIds: readDataSourceRegistryDbIds(getPaprRoot(), appId),
            globalAutoUploadEnabled: isCloudAutoUploadGloballyEnabled(),
            publishLive,
            publishedAt,
          };
        }

        const github = sync.getGitHubSyncItemsReport();
        const tursoCacheKey = tursoSyncItemsCacheKey(appId);
        let turso = !forceRefresh
          ? getCachedTursoSyncItemsReport(tursoCacheKey)
          : null;
        tursoFromCache = turso !== null;
        if (!turso) {
          turso = await buildTursoSyncItemsReport(getPaprAppsRoot(), appId, {
            liveReplicaProbe: forceRefresh,
          });
          if (!forceRefresh) {
            setCachedTursoSyncItemsReport(tursoCacheKey, turso);
          }
          tursoFromCache = false;
        }
        timer.mark("turso");

        let publish = null;
        if (appId) {
          const { buildPublishLayerReport } = await import(
            "./services/cloudSync/webReady.js"
          );
          publish = await buildPublishLayerReport(appId, {
            paprDir: getPaprRoot(),
            cloudPublishing: sync.isCloudPublishingForApp(appId),
            publishLive: appContext?.publishLive === true,
            tursoReport: turso,
          });
          timer.mark("publishLayer");
        }

        let upload = null;
        let appSync = null;
        let uploadError: {
          message: string;
          at: string;
          retryPending?: boolean;
          kind?: "conflict" | "error";
          conflictPaths?: string[];
        } | null = null;
        {
          const { getSyncCoordinator } = await import(
            "./services/cloudSync/SyncCoordinator.js"
          );
          const { buildCoordinatorStatusReport } = await import(
            "./services/cloudSync/coordinatorStatusReport.js"
          );
          const coordinator = getSyncCoordinator();
          upload = buildCoordinatorStatusReport(coordinator, appId);
          timer.mark("uploadCoordinator");
          if (appId) {
            const coordErr = coordinator?.getFlushError(appId);
            const syncErr = sync.getManualFlushError(appId);
            if (coordErr) {
              uploadError = {
                message: coordErr.message,
                at: coordErr.at,
                retryPending: coordErr.retryPending,
                ...(coordErr.kind ? { kind: coordErr.kind } : {}),
                ...(coordErr.conflictPaths?.length
                  ? { conflictPaths: coordErr.conflictPaths }
                  : {}),
              };
            } else if (syncErr) {
              uploadError = {
                ...syncErr,
                retryPending: false,
              };
            }

            const { buildAppSyncV3Report } = await import(
              "./services/syncV3/appSyncV3StatusReport.js"
            );
            const githubReport = sync.getGitHubSyncItemsReport();
            appSync = await buildAppSyncV3Report({
              appId,
              paprDir: getPaprRoot(),
              stateManager: sync.stateManager,
              queuedPaths: githubReport.queuedPaths,
              coordinatorUploading: upload?.status === "uploading",
              coordinatorWaiting: upload?.status === "waiting",
              coordinatorQueued: upload?.waitingReason === "queued",
              queuePosition: upload?.queuePosition,
              queueDepth: upload?.queueDepth,
              flushErrorMessage: uploadError?.message ?? null,
              flushErrorKind: uploadError?.kind,
            });
            timer.mark("appSyncV3");
          }
        }

        let cloudLinks = null;
        let fromCache = false;
        if (!appId) {
          cloudLinks = !forceRefresh ? getCachedCloudLinkSyncReport() : null;
          fromCache = cloudLinks !== null;
          if (!cloudLinks) {
            cloudLinks = await buildCloudLinkSyncReport();
            setCachedCloudLinkSyncReport(cloudLinks);
          }
          timer.mark("cloudLinks");
        }

        let oversizedAppFiles = undefined;
        if (appId) {
          const { buildOversizedAppFilesReport } = await import(
            "./services/cloudSync/oversizedAppFilesReport.js"
          );
          oversizedAppFiles = await buildOversizedAppFilesReport(
            getPaprRoot(),
            appId,
          );
          timer.mark("oversizedFiles");
        }

        const payload = {
          enabled: true,
          github,
          turso,
          tursoCached: tursoFromCache,
          publish,
          upload,
          appSync,
          cloudLinks,
          appContext,
          cached: fromCache,
          ...(appId
            ? {
                uploadError,
                oversizedAppFiles,
              }
            : {}),
        };
        if (appId && !forceRefresh) {
          setCachedSyncItemsAppResponse(
            appId,
            payload as Record<string, unknown>,
          );
        }
        res.json(payload);
      } catch (err) {
        timer.mark("error");
        res.status(500).json({ error: (err as Error).message });
      } finally {
        logSyncItemsRoute(timer, {
          appId,
          forceRefresh,
          tursoCached: tursoFromCache,
          responseCached: responseFromCache,
        });
      }
    });

    app.post("/api/sync/push", async (req, res) => {
      const sync = getCloudSyncService();
      if (!sync) {
        res.status(503).json({ error: "Cloud sync not initialized" });
        return;
      }
      const appId =
        typeof req.body?.appId === "string" && req.body.appId.trim().length > 0
          ? req.body.appId.trim()
          : undefined;
      try {
        if (appId) {
          const { getSyncCoordinator } = await import(
            "./services/cloudSync/SyncCoordinator.js"
          );
          const coordinator = getSyncCoordinator();
          if (coordinator) {
            coordinator.bumpFlushQueue(appId);
          }
          const inFlight = coordinator?.getStatus().activeFlush?.appId === appId;
          sync.pushAppNowInBackground(appId);
          res.status(202).json({
            accepted: true,
            alreadyInProgress: inFlight,
            bumpedQueue: true,
            ...sync.getState(),
          });
          return;
        }
        await sync.pushNow();
        res.json({ success: true, ...sync.getState() });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/sync/pull", async (_req, res) => {
      const sync = getCloudSyncService();
      if (!sync) {
        res.status(503).json({ error: "Cloud sync not initialized" });
        return;
      }
      try {
        await sync.pullNow();
        res.json({ success: true, ...sync.getState() });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/sync/apply-updates", async (_req, res) => {
      const sync = getCloudSyncService();
      if (!sync) {
        res.status(503).json({ error: "Cloud sync not initialized" });
        return;
      }
      try {
        await sync.applyGitRemoteUpdates();
        res.json({ success: true, ...sync.getState() });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/sync/dismiss-updates", async (_req, res) => {
      const sync = getCloudSyncService();
      if (!sync) {
        res.status(503).json({ error: "Cloud sync not initialized" });
        return;
      }
      sync.dismissGitRemoteUpdates();
      res.json({ success: true, ...sync.getState() });
    });

    app.post("/api/sync/retry", async (req, res) => {
      const sync = getCloudSyncService();
      if (!sync) {
        res.status(503).json({ error: "Cloud sync not initialized" });
        return;
      }
      const relativePath =
        typeof req.body?.relativePath === "string" ? req.body.relativePath.trim() : "";
      if (!relativePath) {
        res.status(400).json({ error: "relativePath is required" });
        return;
      }
      try {
        const retried = await sync.retryDeadLetterItem(relativePath);
        if (!retried) {
          res.status(404).json({ error: "Item is not in dead-letter state" });
          return;
        }
        res.json({ success: true, relativePath });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/sync/turso/repair", async (req, res) => {
      const jobId =
        typeof req.body?.jobId === "string" ? req.body.jobId.trim() : "";
      const dbPath =
        typeof req.body?.dbPath === "string" ? req.body.dbPath.trim() : "";
      if (!jobId || !dbPath) {
        res.status(400).json({ error: "jobId and dbPath are required" });
        return;
      }
      try {
        const { repairTursoJobDatabase } = await import("./services/tursoSyncState.js");
        const result = repairTursoJobDatabase(jobId, dbPath);
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    lapRouteRegistrationSection("cloud-sync-routes");

    // ── Vault Sync Status + Triggers ──────────────────────────────────────
    app.get("/api/vault/status", (_req, res) => {
      const vault = getVaultSyncService();
      if (!vault) {
        res.json({ enabled: false, reason: "Vault sync not initialized" });
        return;
      }
      res.json({ enabled: true, ...vault.getState() });
    });

    app.post("/api/vault/push", async (_req, res) => {
      const vault = getVaultSyncService();
      if (!vault) {
        res.status(503).json({ error: "Vault sync not initialized" });
        return;
      }
      try {
        const result = await vault.pushAllKeys();
        res.json({ success: true, ...vault.getState(), result });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/vault/pull-shared", async (_req, res) => {
      const vault = getVaultSyncService();
      if (!vault) {
        res.status(503).json({ error: "Vault sync not initialized" });
        return;
      }
      try {
        const upserted = await vault.pullSharedKeys();
        res.json({ success: true, ...vault.getState(), upserted });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/vault/sync-key", async (req, res) => {
      const vault = getVaultSyncService();
      if (!vault) {
        res.status(503).json({ error: "Vault sync not initialized" });
        return;
      }
      const body = req.body as {
        name?: string;
        previousAudience?: string;
        nextAudience?: string;
        targetOrgId?: string;
        mode?: "delete" | "update";
      };
      if (!body.name?.trim() || (body.mode !== "delete" && body.mode !== "update")) {
        res.status(400).json({ error: "name and mode (delete|update) are required" });
        return;
      }
      try {
        const result = await vault.syncKeyVaultChange({
          name: body.name.trim(),
          previousAudience: body.previousAudience as
            | import("../core/storage/customKeysVault.js").IntegrationKeyVaultAudience
            | undefined,
          nextAudience: body.nextAudience as
            | import("../core/storage/customKeysVault.js").IntegrationKeyVaultAudience
            | undefined,
          targetOrgId: body.targetOrgId,
          mode: body.mode,
        });
        res.json({ success: true, ...vault.getState(), result });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    // Renderer telemetry: validate sync, respond immediately, forward async (never block hot path).
    app.post("/api/telemetry/events", (req, res) => {
      const prepared = prepareRendererTelemetry(req.body);
      if (!prepared.ok) {
        res.status(prepared.status).json({ error: prepared.error });
        return;
      }
      res.sendStatus(204);
      void sendPreparedRendererTelemetry(prepared.payload);
    });

    app.post("/api/bash/run", async (_req, res) => {
      const { MINI_APP_BASH_DISABLED_CODE, MINI_APP_BASH_DISABLED_MESSAGE } =
        await import("./services/appRuntime/miniAppApiPolicy.js");
      res.status(403).json({
        error: MINI_APP_BASH_DISABLED_CODE,
        message: MINI_APP_BASH_DISABLED_MESSAGE,
      });
    });

    app.post("/api/credentials/client-keys", async (req, res) => {
      try {
        const body = req.body as { appId?: string; names?: string[] };
        const resolved = resolveRequestAppId(req, body.appId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const { resolveDesktopClientKeys } = await import(
          "./services/ClientKeysService.js"
        );
        const result = await resolveDesktopClientKeys({
          appId: resolved.appId,
          names: body.names,
        });
        if (result.status && result.error) {
          res.status(result.status).json({ error: result.error });
          return;
        }
        res.json({
          keys: result.keys,
          missing: result.missing,
          rejected: result.rejected,
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post("/api/app/backend/:action", async (req, res) => {
      try {
        const action = req.params.action;
        if (!action?.trim()) {
          res.status(400).json({ error: "action name is required" });
          return;
        }
        const body = req.body as {
          appId?: string;
          params?: Record<string, string>;
        };
        const resolved = resolveRequestAppId(req, body.appId);
        if ("error" in resolved) {
          res.status(resolved.status).json({ error: resolved.error });
          return;
        }
        const appId = resolved.appId;

        const { AppBackendService } = await import(
          "./services/appRuntime/AppBackendService.js"
        );
        const { substituteCustomKeysInCommand } = await import(
          "./utils/keySubstitution.js"
        );
        const { isPlatformInjectedEnvKey } = await import(
          "../core/utils/platformInjectedEnvKeys.js"
        );
        const { sanitizeError } = await import("../core/tools/security.js");

        const backend = new AppBackendService();
        const manifestPath = `apps/${appId}/backend/manifest.json`;
        const fs = await import("fs/promises");
        const path = await import("path");
        const { getPaprRoot } = await import("../core/utils/paprRoot.js");
        const { parseAppBackendManifest } = await import(
          "./services/appRuntime/appBackendManifest.js"
        );
        const manifestRaw = JSON.parse(
          await fs.readFile(
            path.join(getPaprRoot(), manifestPath),
            "utf8",
          ),
        ) as unknown;
        const manifest = parseAppBackendManifest(manifestRaw);
        const spec = manifest.actions[action.trim()];
        if (!spec) {
          res.status(404).json({ error: `Unknown backend action: ${action}` });
          return;
        }

        const vaultEnv: Record<string, string> = {};
        const secretValues: string[] = [];
        if (spec.keys?.length) {
          for (const keyName of spec.keys) {
            if (isPlatformInjectedEnvKey(keyName)) {
              continue;
            }
            const sub = await substituteCustomKeysInCommand(`echo \${${keyName}}`);
            if (sub.usedKeyNames.includes(keyName)) {
              // Extract actual value from the substituted command
              const extractedValue = sub.command.replace(/^echo /,"").trim();
              vaultEnv[keyName] = extractedValue;
              secretValues.push(...sub.keyValues);
            }
          }
        }

        const { resolveDesktopAppBackendDatabaseEnv, collectBackendDatabaseSecrets } =
          await import("./services/appRuntime/appBackendDatabase.js");
        const actionSourceId =
          body.params?.sourceId ??
          spec.sourceId;
        const databaseEnv = await resolveDesktopAppBackendDatabaseEnv({
          appId,
          paprRoot: getPaprRoot(),
          sourceId: actionSourceId,
        });
        secretValues.push(...collectBackendDatabaseSecrets(databaseEnv));

        const { getPaprCallerIdentity } = await import("./utils/paprUserId.js");
        const callerIdentity = getPaprCallerIdentity();
        const loggedIn = Boolean(callerIdentity.userId?.trim());

        const result = await backend.runAction({
          appId,
          action: action.trim(),
          params: body.params,
          vaultEnv,
          callerIdentity,
          loggedIn,
        });

        res.json({
          ...result,
          stdout: sanitizeError(result.stdout, secretValues),
          stderr: sanitizeError(result.stderr, secretValues),
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    lapRouteRegistrationSection("vault-sync-routes");

    // ── Job Files Endpoint ────────────────────────────────────────────────────
    // Serves files from job directories with correct MIME types
    // Supports videos, images, and other media files
    // GET /api/jobs/:jobId/files/:filename
    // ─────────────────────────────────────────────────────────────────────────
    app.get("/api/jobs/:jobId/files/:filename", async (req, res) => {
      try {
        const { jobId, filename } = req.params;
        
        // Security: prevent directory traversal
        if (filename.includes("..") || filename.includes("/")) {
          res.status(400).send("Invalid filename");
          return;
        }

        const jobsService = getJobsService();
        const jobsRootDir = jobsService.getJobsRootPath();
        const filePath = path.join(jobsRootDir, jobId, filename);

        // Check if file exists
        const fs = await import("fs/promises");
        try {
          await fs.access(filePath);
        } catch {
          res.status(404).send("File not found");
          return;
        }

        // Determine MIME type based on extension
        const ext = path.extname(filename).toLowerCase();
        const mimeTypes: Record<string, string> = {
          // Video formats
          ".mp4": "video/mp4",
          ".webm": "video/webm",
          ".ogg": "video/ogg",
          ".mov": "video/quicktime",
          ".avi": "video/x-msvideo",
          // Image formats
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".png": "image/png",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
          // Audio formats
          ".mp3": "audio/mpeg",
          ".wav": "audio/wav",
          ".oga": "audio/ogg",
          // Documents
          ".pdf": "application/pdf",
          ".json": "application/json",
          ".txt": "text/plain",
        };

        const contentType = mimeTypes[ext] || "application/octet-stream";
        res.setHeader("Content-Type", contentType);
        
        // Send the file as binary
        res.sendFile(filePath);
      } catch (error) {
        console.error("[Gateway] Failed to serve job file:", error);
        res.status(500).send("Failed to read job file");
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    app.get("/api/generated-media/:filename", async (req, res) => {
      try {
        const { filename } = req.params;
        if (!filename || filename.includes("..") || filename.includes("/")) {
          res.status(400).send("Invalid filename");
          return;
        }

        const mediaRoot = path.join(getPaprRoot(), "data", "generated-media");
        const filePath = path.join(mediaRoot, filename);
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(mediaRoot) + path.sep)) {
          res.status(400).send("Invalid filename");
          return;
        }

        const fs = await import("fs/promises");
        try {
          await fs.access(resolved);
        } catch {
          res.status(404).send("File not found");
          return;
        }

        const ext = path.extname(filename).toLowerCase();
        const mimeTypes: Record<string, string> = {
          ".mp4": "video/mp4",
          ".webm": "video/webm",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
        };
        res.setHeader("Content-Type", mimeTypes[ext] ?? "application/octet-stream");
        res.sendFile(resolved);
      } catch (error) {
        console.error("[Gateway] Failed to serve generated media:", error);
        res.status(500).send("Failed to read generated media");
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    lapRouteRegistrationSection("job-files-and-generated-media");

    registerCloudDesktopPreviewRoutes(app);

    // Serve mini-app files for iframe rendering in UI.
    // Supports on-the-fly TypeScript transpilation via esbuild.
    // Use RegExp route for Express/path-to-regexp compatibility.
    app.get(/^\/apps\/([^/]+)\/?(.*)$/, async (req, res) => {
      const staticReceivedAt = performance.now();
      let staticAppId = "";
      let staticRequestedPath = "index.html";
      let staticStatusCode = 500;
      let staticByteLength: number | undefined;
      const { createMiniAppStaticServeTimer } = await import(
        "./utils/miniAppStaticServeLog.js"
      );
      const staticServeTimer = createMiniAppStaticServeTimer(staticReceivedAt);
      const { enterInteractiveHotPath, leaveInteractiveHotPath } = await import(
        "./services/gatewayInteractivePriority.js"
      );
      enterInteractiveHotPath("mini-app:static");
      try {
        const appService = getAppService();
        const appId = req.params[0];
        staticAppId = appId;
        const wildcard = req.params[1];
        const requestedPath =
          typeof wildcard === "string" && wildcard.length > 0
            ? wildcard
            : "index.html";
        staticRequestedPath = requestedPath;
        staticServeTimer.markPhase("setupMs");

        if (requestedPath.includes("..")) {
          staticStatusCode = 400;
          res.status(400).send("Invalid app path");
          return;
        }

        // Per-app origin: ask for an origin-keyed agent cluster so this app
        // cannot share a main thread with the chat UI, and refuse to serve one
        // app's files from another app's origin — that would pull B's code into
        // A's process and undo the isolation we just asked for.
        const { appIdFromHost } = await import(
          "../core/miniApps/miniAppOrigin.js"
        );
        const hostAppId = appIdFromHost(req.headers.host);
        if (hostAppId) {
          if (hostAppId.toLowerCase() !== appId.toLowerCase()) {
            staticStatusCode = 403;
            res.status(403).send("App origin does not match requested app");
            return;
          }
          res.setHeader("Origin-Agent-Cluster", "?1");
        }

        const ext = path.extname(requestedPath).toLowerCase();

        const {
          getMiniAppContentType,
          isMiniAppBinaryExtension,
        } = await import("./utils/miniAppStaticAssets.js");

        if (isMiniAppBinaryExtension(ext)) {
          const filePath = await appService.resolveAppFilePath(
            appId,
            requestedPath,
          );
          staticServeTimer.markPhase("resolveMs");
          if (!filePath) {
            staticStatusCode = 404;
            res.status(404).send("Not found");
            return;
          }
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
          res.setHeader("Content-Type", getMiniAppContentType(ext));
          staticStatusCode = 200;
          res.sendFile(filePath);
          return;
        }

        // For bundled apps: serve dist/ output when requesting the bundled JS/CSS.
        // The iframe's index.html references dist/app.js and dist/app.css.
        if (requestedPath.startsWith("dist/")) {
          const distPath = await appService.resolveAppFilePath(appId, requestedPath);
          staticServeTimer.markPhase("resolveMs");
          if (!distPath) {
            staticStatusCode = 404;
            res.status(404).send("Not found — run build first");
            return;
          }
          const fs = await import("fs/promises");
          let distStat;
          try {
            distStat = await fs.stat(distPath);
          } catch {
            staticStatusCode = 404;
            res.status(404).send("Not found — run build first");
            return;
          }
          staticServeTimer.markPhase("statMs");
          const {
            buildMiniAppDistEtag,
            ifNoneMatchIncludes,
            MINI_APP_DIST_CACHE_CONTROL,
            readIfNoneMatchHeader,
          } = await import("./utils/miniAppDistCache.js");
          const etag = buildMiniAppDistEtag(distStat);
          res.setHeader("Cache-Control", MINI_APP_DIST_CACHE_CONTROL);
          res.setHeader("ETag", etag);
          res.setHeader("Content-Type", getMiniAppContentType(ext));
          if (
            ifNoneMatchIncludes(readIfNoneMatchHeader(req.headers), etag)
          ) {
            staticStatusCode = 304;
            res.status(304).end();
            return;
          }
          const distContent = await fs.readFile(distPath, "utf8");
          staticServeTimer.markPhase("readMs");
          staticByteLength = Buffer.byteLength(distContent, "utf8");
          if (ext === ".js") {
            const { appendModuleRanMarker } = await import(
              "./utils/miniAppBootWatchdog.js"
            );
            const body = appendModuleRanMarker(distContent);
            staticByteLength = Buffer.byteLength(body, "utf8");
            staticServeTimer.markPhase("transformMs");
            staticStatusCode = 200;
            res.send(body);
            return;
          }
          staticStatusCode = 200;
          res.send(distContent);
          return;
        }

        let content = await appService.readAppFile(appId, requestedPath);
        staticServeTimer.markPhase("readMs");
        if (content === null) {
          staticStatusCode = 404;
          res.status(404).send("Not found");
          return;
        }

        // Legacy per-file TS transpilation (for apps that don't use bundled imports).
        // Bundled apps serve pre-built dist/app.js instead of transpiling per-request.
        if (ext === ".ts" || ext === ".tsx") {
          try {
            const nodeBuiltins = [
              "fs", "path", "crypto", "child_process", "os",
              "net", "http", "https", "stream", "buffer", "process",
            ];
            
            const contentStr = content as string;
            const hasNodeImports = nodeBuiltins.some(
              (mod) =>
                contentStr.includes(`from '${mod}'`) ||
                contentStr.includes(`from "${mod}"`) ||
                contentStr.includes(`require('${mod}')`) ||
                contentStr.includes(`from 'node:${mod}'`) ||
                contentStr.includes(`from "node:${mod}"`),
            );

            if (hasNodeImports) {
              console.warn(
                `[Gateway] Mini-app ${appId}/${requestedPath} imports Node.js modules. ` +
                  `These APIs are not available in browser context. ` +
                  `Use window.paprAPI.invoke() instead.`,
              );
            }

            const { transpileMiniAppTypeScript } = await import(
              "./utils/miniAppTranspile.js"
            );
            const transpileResult = await transpileMiniAppTypeScript(
              contentStr,
              requestedPath,
            );
            if (!transpileResult.success) {
              const { isEsbuildInfrastructureError } = await import(
                "./utils/miniAppTranspile.js"
              );
              const rawMessage =
                transpileResult.message ?? "Unknown error";
              const location =
                transpileResult.line !== undefined
                  ? ` at line ${transpileResult.line}`
                  : "";
              const prefix = isEsbuildInfrastructureError(rawMessage)
                ? "esbuild infrastructure error (NOT app code)"
                : "TypeScript compilation error";
              const message = `${prefix}${location}: ${rawMessage}`;
              console.error(
                `[Gateway] TypeScript transpile error for ${requestedPath}:`,
                message,
              );
              staticStatusCode = 500;
              res.status(500).send(message);
              return;
            }

            {
              const { appendModuleRanMarker } = await import(
                "./utils/miniAppBootWatchdog.js"
              );
              content = appendModuleRanMarker(transpileResult.code ?? contentStr);
            }
            staticServeTimer.markPhase("transpileMs");
          } catch (transpileError) {
            const { formatEsbuildErrorMessage } = await import(
              "./utils/miniAppTranspile.js"
            );
            const formatted = formatEsbuildErrorMessage(
              (transpileError as Error).message,
            );
            console.error(
              `[Gateway] TypeScript transpile error for ${requestedPath}:`,
              transpileError,
            );
            staticStatusCode = 500;
            res.status(500).send(`TypeScript compilation error:\n${formatted}`);
            return;
          }
        }

        if (ext === ".html" && typeof content === "string") {
          const appDir = await appService.getAppPath(appId);
          if (appDir && requestedPath === "index.html") {
            const { preferBundledEntryInHtml } = await import(
              "./utils/miniAppBuild.js"
            );
            content = await preferBundledEntryInHtml(content, appDir);
          }

          const { injectMiniAppBaseStyles } = await import(
            "./utils/miniAppBaseStyles.js"
          );
          const { getBrandService, buildBrandStyleTag } = await import(
            "./services/BrandService.js"
          );
          const brand = await getBrandService().loadMergedBrand(appId);
          const brandStyleTag = buildBrandStyleTag(brand.cssVariables);
          content = injectMiniAppBaseStyles(content, brandStyleTag);

          const { injectMiniAppNativeDialogShim } = await import(
            "./utils/injectMiniAppNativeDialogShim.js"
          );
          content = injectMiniAppNativeDialogShim(content);

          const { injectMiniAppApiErrorFetch } = await import(
            "./utils/injectMiniAppApiErrorFetch.js"
          );
          content = injectMiniAppApiErrorFetch(content);

          const { injectMiniAppPreviewFetchGate } = await import(
            "./utils/injectMiniAppPreviewFetchGate.js"
          );
          content = await injectMiniAppPreviewFetchGate(content);

          // Boot watchdog: turns a silent blank iframe into a labeled
          // diagnostic banner (entry module never ran / threw / rendered nothing).
          const { injectMiniAppBootWatchdog } = await import(
            "./utils/miniAppBootWatchdog.js"
          );
          content = injectMiniAppBootWatchdog(content);
          staticServeTimer.markPhase("htmlInjectMs");
        }

        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.setHeader("Content-Type", getMiniAppContentType(ext));
        if (typeof content === "string") {
          staticByteLength = Buffer.byteLength(content, "utf8");
        }
        staticStatusCode = 200;
        res.send(content);
        // Register app-open reconcile; cloud→local pull runs after first DB read (data paint).
        if (requestedPath === "index.html") {
          void import("./services/tursoPullScheduler.js").then(
            ({ scheduleTursoPullForAppOpen }) => {
              scheduleTursoPullForAppOpen(appId);
            },
          );
        }
      } catch (error) {
        console.error("[Gateway] Failed to serve app file:", error);
        staticStatusCode = 500;
        res.status(500).send("Failed to read app file");
      } finally {
        leaveInteractiveHotPath("mini-app:static");
        staticServeTimer.finishIfNeeded({
          appId: staticAppId,
          requestedPath: staticRequestedPath,
          statusCode: staticStatusCode,
          byteLength: staticByteLength,
        });
      }
    });

    // SPA fallback (static assets registered early at startup)
    if (productionUiPath) {
      registerProductionUiCatchAll(app);
      console.log("[Gateway] Serving UI from:", productionUiPath);
    }

    lapRouteRegistrationSection("mini-app-hosting-and-preview-routes");

    gatewayReady = true;
    const { markGatewayRoutesReady } = await import(
      "./services/gatewayReadiness.js"
    );
    markGatewayRoutesReady();
    printGatewayStartupSummary();
    console.log("[Gateway] All routes registered — gateway fully ready");

    void import("./services/GatewayBackgroundWorkerClient.js")
      .then(({ ensureGatewayBackgroundWorkerStarted }) =>
        ensureGatewayBackgroundWorkerStarted(),
      )
      .catch((err) => {
        console.warn(
          "[Gateway] Background worker start failed (non-fatal):",
          err instanceof Error ? err.message : err,
        );
      });

    if (!isCloudAgentGatewayMode()) {
      void import("./services/tursoPullScheduler.js").then(
        ({ markTursoPullSchedulerGatewayBoot }) => {
          markTursoPullSchedulerGatewayBoot();
        },
      );
      timeStartupSync("post-ready", "JobsScheduler.start", () => {
        getJobsScheduler().start();
      });
      void import("./services/platforms/SessionKeeperService.js")
        .then(({ getSessionKeeperService }) => {
          getSessionKeeperService().start();
        })
        .catch((err) => {
          console.warn(
            "[Gateway] Session keeper start failed:",
            err instanceof Error ? err.message : err,
          );
        });
      void import("./services/jobs/deferredStartupBootstrap.js")
        .then(({ runDeferredJobsWorkspaceBootstrap }) =>
          runDeferredJobsWorkspaceBootstrap(),
        )
        .catch((err) => {
          console.warn(
            "[Gateway] Deferred jobs bootstrap failed:",
            err instanceof Error ? err.message : err,
          );
        });
    }

    // Cloud services start AFTER the HTTP server is listening.
    // Staggered to avoid thundering herd on memory.papr.ai at startup.
    // Skipped in cloud_agent mode (Cloud Run agent gateway is stateless per-run).
    if (!isCloudAgentGatewayMode() && process.env.CLOUD_SYNC_ENABLED !== "false") {
      const cloudSyncStartupDelayMs = Number(
        process.env.CLOUD_SYNC_STARTUP_DELAY_MS ?? "30000",
      );
      const cloudSyncStartupRetryMs = Number(
        process.env.CLOUD_SYNC_STARTUP_RETRY_MS ?? "5000",
      );

      const tryDeferredCloudSyncStartup = (): void => {
        void (async () => {
          await timeStartupStep("deferred", "CloudSync.startup (wait+init)", async () => {
            const { waitForWorkspaceReady } = await import(
              "./services/workspaceReadiness.js"
            );
            await waitForWorkspaceReady();

            const { waitForInteractiveQuietBeforeBackgroundWork } =
              await import("./services/gatewayInteractivePriority.js");
            await waitForInteractiveQuietBeforeBackgroundWork(
              "CloudSync.startup",
            );

            if (getCloudSyncService()) {
              console.log(
                "[Gateway] Cloud sync already initialized (e.g. workspace switch) — skipping deferred startup init",
              );
              return;
            }
            const cloudSync = initializeCloudSyncService();
            ensureTursoSyncBridge();
            await cloudSync.initialize();
          }).catch((err) => {
            console.warn(
              "[Gateway] Cloud sync init failed (non-fatal):",
              (err as Error).message,
            );
          });
        })().catch((err) => {
          console.warn(
            "[Gateway] Deferred cloud sync startup failed:",
            (err as Error).message,
          );
          setTimeout(tryDeferredCloudSyncStartup, cloudSyncStartupRetryMs);
        });
      };

      setTimeout(tryDeferredCloudSyncStartup, cloudSyncStartupDelayMs);

      const tryDeferredVaultSyncStartup = (): void => {
        void (async () => {
          await timeStartupStep("deferred", "VaultSync.startup (wait+init)", async () => {
            const { waitForWorkspaceReady } = await import(
              "./services/workspaceReadiness.js"
            );
            await waitForWorkspaceReady();

            const { waitForInteractiveQuietBeforeBackgroundWork } =
              await import("./services/gatewayInteractivePriority.js");
            await waitForInteractiveQuietBeforeBackgroundWork(
              "VaultSync.startup",
            );

            const vaultStartupDelayMs = Number(
              process.env.VAULT_STARTUP_DELAY_MS ?? "5000",
            );
            if (vaultStartupDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, vaultStartupDelayMs));
            }

            const vaultSync = await initializeVaultSyncService({
              gatewayPort: Number(PORT),
            });
            getCustomKeysService().onKeyChange((keyName) => {
              if (keyName) {
                vaultSync.onKeyChanged(keyName).catch((e) =>
                  console.warn(
                    "[Gateway] Vault key push failed:",
                    (e as Error).message,
                  ),
                );
              } else {
                vaultSync.scheduleDebouncedPushAll();
              }
            });
          });
        })().catch((err) => {
          console.warn(
            "[Gateway] Vault sync init failed (non-fatal):",
            err instanceof Error ? err.message : err,
          );
        });
      };

      tryDeferredVaultSyncStartup();

      const tursoStartupDelayMs = Number(
        process.env.TURSO_STARTUP_DELAY_MS ?? "15000",
      );
      setTimeout(() => {
        const tursoBridge = ensureTursoSyncBridge();
        void import("./services/tursoSyncSession.js")
          .then(({ isTursoStartupSyncIndexEnabled }) => {
            if (!isTursoStartupSyncIndexEnabled()) {
              console.log(
                "[Gateway] Turso startup sync-index skipped (set TURSO_STARTUP_SYNC_INDEX=true to enable; heartbeat + app-open reconcile remain active)",
              );
              return;
            }
            return timeStartupStep(
              "deferred",
              "Turso.syncTursoFromSyncIndex",
              async () => {
                const { syncTursoFromSyncIndex } = await import(
                  "./services/TursoSyncBridge.js"
                );
                const summary = await syncTursoFromSyncIndex();
                if (summary.pulled > 0 || summary.pushed > 0) {
                  console.log(
                    `[Gateway] Turso startup sync-index: pulled=${summary.pulled} pushed=${summary.pushed}`,
                  );
                }
              },
            );
          })
          .catch((err) =>
            console.warn(
              "[Gateway] Turso startup sync-index failed (non-fatal):",
              (err as Error).message.slice(0, 120),
            ),
          );
        if (process.env.TURSO_PULL_ON_STARTUP === "true") {
          void tursoBridge.pullLinkedSourcesIfNeeded().catch((err) =>
            console.warn(
              "[Gateway] Turso startup pull failed (non-fatal):",
              (err as Error).message.slice(0, 120),
            ),
          );
        }
        void import("./services/tursoPushScheduler.js")
          .then(({ pushDirtyLinkedJobsOnStartup }) => pushDirtyLinkedJobsOnStartup())
          .catch((err) =>
            console.warn(
              "[Gateway] Turso startup dirty push failed (non-fatal):",
              (err as Error).message.slice(0, 120),
            ),
          );
        void import(
          "./services/tursoReplica/cutover/tursoReplicaCutoverOrchestrator.js"
        )
          .then(({ runPendingReplicaCutovers }) =>
            runPendingReplicaCutovers({ fromStartup: true }).then((batch) => {
              if (batch.results.length === 0) {
                return;
              }
              console.log(
                `[Gateway] Replica cutover: attempted=${batch.attempted} ` +
                  `succeeded=${batch.succeeded} blocked=${batch.blocked} skipped=${batch.skipped}`,
              );
              for (const result of batch.results) {
                if (!result.ok && result.error) {
                  console.warn(
                    `[Gateway] Replica cutover ${result.dbId}: ${result.error.slice(0, 160)}`,
                  );
                }
              }
            }),
          )
          .catch((err) =>
            console.warn(
              "[Gateway] Replica cutover startup failed (non-fatal):",
              (err as Error).message.slice(0, 120),
            ),
          );
        void import(
          "./services/tursoReplica/cutover/tursoReplicaCutoverMigrationAuthority.js"
        )
          .then(({ repairAllReplicaMigrationAuthorityOnStartup }) => {
            const repairEnabled =
              process.env.TURSO_MIGRATION_REPAIR_ON_STARTUP === "1" ||
              process.env.TURSO_MIGRATION_REPAIR_ON_STARTUP === "true";
            if (!repairEnabled) {
              console.log(
                "[Gateway] Skipping workspace-wide replica migration repair on startup " +
                  "(per-DB repair still runs on publish/pull/drift; set TURSO_MIGRATION_REPAIR_ON_STARTUP=1 for full scan)",
              );
              return;
            }
            const delayMs = Number(
              process.env.TURSO_MIGRATION_REPAIR_STARTUP_DELAY_MS ?? 120_000,
            );
            const run = () => {
              void repairAllReplicaMigrationAuthorityOnStartup().catch((err) =>
                console.warn(
                  "[Gateway] Replica migration repair startup failed (non-fatal):",
                  (err as Error).message.slice(0, 120),
                ),
              );
            };
            if (delayMs <= 0) {
              run();
              return;
            }
            console.log(
              `[Gateway] Deferring replica migration repair for ${delayMs}ms ` +
                "(interactive app reads take priority)",
            );
            setTimeout(run, delayMs);
          })
          .catch((err) =>
            console.warn(
              "[Gateway] Replica migration repair startup failed (non-fatal):",
              (err as Error).message.slice(0, 120),
            ),
          );
        void import("./utils/tursoReplicaEnabled.js")
          .then(({ isLegacyWorkspaceRowSyncEnabled }) => {
            if (!isLegacyWorkspaceRowSyncEnabled()) {
              return;
            }
            return import("./services/syncV3/workspaceLogSync.js").then(
              async ({ catchUpAllLinkedSourcesFromWorkspaceLog }) => {
                const appsRoot = tursoBridge.getAppsRootDir();
                if (!appsRoot) {
                  return;
                }
                const applied =
                  await catchUpAllLinkedSourcesFromWorkspaceLog(appsRoot);
                if (applied > 0) {
                  console.log(
                    `[Gateway] Workspace log startup catch-up materialized ${applied} row op(s)`,
                  );
                }
              },
            );
          })
          .catch((err) =>
            console.warn(
              "[Gateway] Workspace log startup catch-up failed (non-fatal):",
              (err as Error).message.slice(0, 120),
            ),
          );
        void import("./services/DatabaseMemorySync.js")
          .then(({ startDatabaseMemorySync }) => startDatabaseMemorySync())
          .catch((err) =>
            console.warn(
              "[Gateway] Database memory sync start failed (non-fatal):",
              (err as Error).message.slice(0, 120),
            ),
          );
        void import("./services/TursoLinkedDbWatcher.js")
          .then(({ startTursoLinkedDbWatcher }) => startTursoLinkedDbWatcher())
          .catch((err) =>
            console.warn(
              "[Gateway] Turso DB watcher failed (non-fatal):",
              (err as Error).message.slice(0, 120),
            ),
          );
      }, tursoStartupDelayMs);
    }

    // Handle shutdown
    const shutdown = async () => {
      console.log("[Gateway] Shutting down gracefully...");
      stopGatewayEventLoopMonitor();

      try {
        const { shutdownGatewayBackgroundWorker } = await import(
          "./services/GatewayBackgroundWorkerClient.js"
        );
        await shutdownGatewayBackgroundWorker();
      } catch (error) {
        console.error("[Gateway] Failed to stop background worker:", error);
      }

      // Stop code indexing
      try {
        const { stopCodeIndexing } = await import(
          "./services/CodeIndexingService.js"
        );
        await stopCodeIndexing();
      } catch (error) {
        console.error("[Gateway] Failed to stop code indexing:", error);
      }

      // Stop all running jobs before exit
      try {
        const jobsService = getJobsService();
        await jobsService.stopAllJobs();
      } catch (error) {
        console.error("[Gateway] Failed to stop jobs:", error);
      }

      // Cleanup AppService file watchers
      try {
        const appService = getAppService();
        appService.cleanup();
      } catch (error) {
        console.error("[Gateway] Failed to cleanup AppService:", error);
      }

      // Stop cloud sync watcher
      try {
        const sync = getCloudSyncService();
        if (sync) await sync.stop();
      } catch (error) {
        console.error("[Gateway] Failed to stop cloud sync:", error);
      }

      try {
        try {
          const { stopDatabaseMemorySync } = await import(
            "./services/DatabaseMemorySync.js"
          );
          stopDatabaseMemorySync();
        } catch {
          /* non-fatal */
        }
        const { stopTursoLinkedDbWatcher } = await import(
          "./services/TursoLinkedDbWatcher.js"
        );
        await stopTursoLinkedDbWatcher();
      } catch (error) {
        console.error("[Gateway] Failed to stop Turso DB watcher:", error);
      }

      try {
        const { cancelAllScheduledTursoReplicaPushes } = await import(
          "./services/tursoReplica/tursoReplicaPushScheduler.js"
        );
        cancelAllScheduledTursoReplicaPushes("gateway shutdown");
        const { drainTursoReplicaConnections } = await import(
          "./services/tursoReplica/TursoReplicaService.js"
        );
        await drainTursoReplicaConnections("gateway shutdown");
      } catch (error) {
        console.error("[Gateway] Failed to drain Turso replica connections:", error);
      }

      try {
        const { getSessionKeeperService } = await import(
          "./services/platforms/SessionKeeperService.js"
        );
        getSessionKeeperService().stop();
        const { closeRealChromePlatformSession } = await import(
          "./services/platforms/platformAgentBrowser.js"
        );
        await closeRealChromePlatformSession();
        const { getPlatformSessionService } = await import(
          "./services/platforms/PlatformSessionService.js"
        );
        await getPlatformSessionService().shutdown();
      } catch (error) {
        console.error("[Gateway] Failed to stop platform sessions:", error);
      }

      getJobsScheduler().stop();
      dbPool.terminate();
      server.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Exit when Electron main dies (SIGSEGV / force quit) so we don't orphan port 18789.
    if (typeof process.send === "function") {
      process.on("disconnect", () => {
        console.warn(
          "[Gateway] Parent IPC disconnected — shutting down to avoid orphan process",
        );
        void shutdown().finally(() => {
          process.exit(0);
        });
      });
    }
    
    // Handle system power state changes from Electron main process
    process.on("message", async (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      
      const msg = message as { type?: string; timestamp?: number; event?: unknown };
      if (msg.type === "HEALTH_OBSERVATION") { recordGatewayHealthEvent(msg.event); return; }
      
      if (msg.type === "SYSTEM_SUSPEND") {
        console.log("[Gateway] System suspending - pausing operations");
        // Note: Node.js process will be suspended by OS, no cleanup needed
        // The OS will freeze all timers and I/O operations
      } else if (msg.type === "SYSTEM_RESUME") {
        console.log(
          "[Gateway] System resumed — scheduling job reconcile (deferred until interactive quiet)",
        );
        scheduleCoalescedBackgroundWork("system:resume-jobs", async () => {
          try {
            const jobsService = getJobsService();
            await jobsService.reconcileStaleRunningJobs();
            await getJobsScheduler().tickNow();
            console.log(
              "[Gateway] Job reconcile complete after system resume (background)",
            );
          } catch (error) {
            console.error(
              "[Gateway] Failed to reconcile jobs after system resume:",
              error,
            );
          }
        });
      }
    });
    
    // Scheduler + session keeper start after deferred jobs bootstrap (see gatewayReady block).

    // Start code indexing after a delay (non-blocking)
    console.log('[Gateway] Scheduling code indexing check in 3 seconds...');
    setTimeout(async () => {
      console.log('[Gateway] Code indexing check starting...');
      try {
        const { getPaprApiKey: resolvePaprKey } = await import('./utils/keyResolver.js');
        console.log('[Gateway] Requesting PAPR_API_KEY...');
        const paprKey = await resolvePaprKey();
        
        if (paprKey) {
          console.log('[Gateway] PAPR_API_KEY found, starting code indexing...');
          const { ensureIndexingStarted } = await import('./services/CodeIndexingService.js');
          await ensureIndexingStarted(paprKey);
          console.log('[Gateway] Code indexing initialization complete');
        } else {
          console.log('[Gateway] No PAPR_API_KEY found, skipping code indexing');
        }
      } catch (error) {
        console.error('[Gateway] Failed to start code indexing:', error);
        console.error('[Gateway] Error stack:', (error as Error).stack);
      }
    }, 3000); // Wait 3 seconds after Gateway starts
  } catch (error) {
    console.error("[Gateway] Failed to start:", error);
    process.exit(1);
  }
}

// Start the gateway
startGateway();

// Increase max listeners for process IPC (CustomKeysService uses many concurrent requests)
process.setMaxListeners(20);

// Track heap growth. The gateway has been aborting on V8 OOM mid-turn, and the
// ceiling cannot be raised (Electron clamps it to the 4GB default), so the only
// way forward is capturing where the memory goes before the limit is reached.
void import("./services/MemoryWatchdog.js")
  .then(({ startMemoryWatchdog }) => startMemoryWatchdog())
  .catch((error) => {
    console.warn("[Gateway] Memory watchdog unavailable:", error);
  });

void import("./services/FdWatchdog.js")
  .then(({ startFdWatchdog }) => startFdWatchdog())
  .catch((error) => {
    console.warn("[Gateway] FD watchdog unavailable:", error);
  });

void import("../core/utils/spawnResourceErrorHandler.js")
  .then(({ setSpawnResourceErrorHandler }) =>
    setSpawnResourceErrorHandler((reason) => {
      void import("./services/fdPressureRecovery.js").then(
        ({ attemptFdPressureRecovery }) =>
          attemptFdPressureRecovery(reason),
      );
    }),
  )
  .catch((error) => {
    console.warn("[Gateway] Spawn resource error handler unavailable:", error);
  });

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  console.error("[Gateway] Uncaught exception:", error);
  // Exit on EADDRINUSE or other fatal errors to prevent zombie processes
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error("[Gateway] Fatal error: Port already in use. Exiting.");
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[Gateway] Unhandled rejection:", reason);
});
