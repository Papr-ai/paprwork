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
import { initializeChatService } from "./services/ChatService.js";
import { initializeDocumentService } from "./services/DocumentService.js";
import { initializeAppService } from "./services/AppService.js";
import { getAppService } from "./services/AppService.js";
import {
  initializeJobsService,
  getJobsService,
} from "./services/JobsService.js";
import { initializeSkillService } from "./services/SkillService.js";
import { initializeBundleService } from "./services/BundleService.js";
import { initializeSubAgentService } from "./services/SubAgentService.js";
import { initializePlanService } from "./services/PlanService.js";
import { getJobsScheduler } from "./services/JobsScheduler.js";
import { initializeWorkspaceService } from "./services/WorkspaceService.js";
import { setupWebSocketHandlers } from "./websocket/index.js";
import {
  initializePermissionBridge,
  requestPermissionFromMain,
} from "./permissions/GatewayPermissionBridge.js";
import { setPermissionRequester } from "./permissions/PermissionRequester.js";
import type { KeyPermissionRequest } from "../core/types/permissions.js";
import { initializeDbPool } from "./services/DbQueryPool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.GATEWAY_PORT || 18789;
// Listen on all interfaces (0.0.0.0) to accept connections from both localhost and 127.0.0.1
const HOST = process.env.GATEWAY_HOST || "0.0.0.0";

/**
 * Initialize all services
 */
async function initializeServices(): Promise<void> {
  console.log("[Gateway] Initializing services...");

  try {
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
    await initializeAgentService({
      mode: storageMode,
      paprApiKey: undefined, // Will be loaded lazily
      openaiApiKey: undefined, // Will be loaded lazily
    });
    console.log("[Gateway] AgentService initialized");

    // Initialize workspace (creates ~/PAPR/workspace/ and templates on first run)
    console.log("[Gateway] Initializing WorkspaceService...");
    await initializeWorkspaceService();
    console.log("[Gateway] WorkspaceService initialized");

    // Note: Code indexing now uses lazy initialization
    // It will start automatically when PAPR_API_KEY is first used by an agent

    // Initialize other services
    console.log("[Gateway] Initializing ChatService...");
    await initializeChatService();
    console.log("[Gateway] ChatService initialized");

    console.log("[Gateway] Initializing DocumentService...");
    await initializeDocumentService();
    console.log("[Gateway] DocumentService initialized");

    console.log("[Gateway] Initializing AppService...");
    await initializeAppService();
    console.log("[Gateway] AppService initialized");

    console.log("[Gateway] Initializing JobsService...");
    await initializeJobsService();
    console.log("[Gateway] JobsService initialized");

    console.log("[Gateway] Initializing SkillService...");
    await initializeSkillService();
    console.log("[Gateway] SkillService initialized");

    console.log("[Gateway] Initializing BundleService...");
    await initializeBundleService();
    console.log("[Gateway] BundleService initialized");

    console.log("[Gateway] Initializing SubAgentService...");
    await initializeSubAgentService();
    console.log("[Gateway] SubAgentService initialized");

    console.log("[Gateway] Initializing PlanService...");
    await initializePlanService();
    console.log("[Gateway] PlanService initialized");

    // Register built-in sleep job (depends on JobsService being initialized)
    const { getWorkspaceService } =
      await import("./services/WorkspaceService.js");
    await getWorkspaceService().ensureSleepJob();

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
async function startGateway(): Promise<void> {
  console.log("[Gateway] Paprwork V2 Gateway starting...");
  console.log("[Gateway] Platform:", process.platform);
  console.log("[Gateway] Node:", process.version);

  try {
    // Initialize permission system
    console.log("[Gateway] Initializing permission system...");
    initializePermissionBridge();
    setPermissionRequester(async (request: KeyPermissionRequest) => {
      return await requestPermissionFromMain(request);
    });
    console.log("[Gateway] Permission system initialized");

    // Set up key cache invalidation listener
    console.log("[Gateway] Setting up key cache invalidation listener...");
    const { setupKeyCacheInvalidationListener } = await import(
      "./utils/keyResolver.js"
    );
    setupKeyCacheInvalidationListener();
    console.log("[Gateway] Key cache invalidation listener ready");

    // Initialize services first
    await initializeServices();

    // Create Express app
    const app = express();
    const server = createServer(app);

    // Create WebSocket server
    const wss = new WebSocketServer({ server });
    console.log("[Gateway] WebSocket server created");

    // Setup WebSocket handlers
    setupWebSocketHandlers(wss);

    // Health check endpoint (before static files)
    app.get("/health", (_req, res) => {
      res.json({ status: "ok", timestamp: Date.now() });
    });

    // ── Mini-app SQLite query API ────────────────────────────────────────────
    // All synchronous better-sqlite3 calls run in a worker-thread pool so they
    // never block the main event loop (keeps health checks & WebSocket alive).
    //
    // Apps call: fetch('/api/db/query', { method: 'POST', body: JSON.stringify({ appId, sql, params }) })
    // Apps call: fetch('/api/db/schema?appId=<id>') to list tables and columns
    //
    // Security:
    //  - Only SELECT statements allowed on /query (read-only)
    //  - Only db paths that are registered in the app's data-sources.json
    //  - Path traversal blocked at the linked dbPath level
    //
    // Source routing (when sourceId is omitted):
    //  - Single source → use it automatically
    //  - Multiple sources → extract primary table from SQL, find which source has it
    //  - If ambiguous → error lists available aliases so the caller can add sourceId
    // ─────────────────────────────────────────────────────────────────────────

    const dbPool = initializeDbPool(
      new URL("./workers/db-query-worker.js", import.meta.url),
    );

    /**
     * Extract the primary table name from a SQL statement for auto-routing across
     * multiple linked data sources. Handles INSERT INTO, UPDATE, DELETE FROM, SELECT FROM.
     * Returns null if the table name cannot be determined.
     */
    function extractPrimaryTable(sql: string): string | null {
      const s = sql.trim();
      let m: RegExpMatchArray | null;
      m = s.match(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`]?(\w+)/i);
      if (m) return m[1];
      m = s.match(/\bREPLACE\s+INTO\s+["'`]?(\w+)/i);
      if (m) return m[1];
      m = s.match(/\bUPDATE\s+(?:OR\s+\w+\s+)?["'`]?(\w+)/i);
      if (m) return m[1];
      m = s.match(/\bDELETE\s+FROM\s+["'`]?(\w+)/i);
      if (m) return m[1];
      m = s.match(/\bFROM\s+["'`]?(\w+)/i);
      if (m) return m[1];
      return null;
    }

    /**
     * Resolve which linked data source to use for a query.
     *
     * Priority:
     * 1. Explicit sourceId (by id or alias) — exact match.
     * 2. Single source — use it automatically.
     * 3. Multiple sources + SQL provided — extract table name, check sqlite_master
     *    on each source via the worker pool, pick the first that has the table.
     * 4. Multiple sources + no match — throw a descriptive error listing aliases.
     */
    async function resolveDataSource(
      sources: import("./services/AppService.js").AppDataSource[],
      sourceId?: string,
      sql?: string,
    ): Promise<import("./services/AppService.js").AppDataSource> {
      if (sourceId) {
        const found = sources.find(
          (s) => s.id === sourceId || s.alias === sourceId,
        );
        if (!found) {
          const available = sources.map((s) => s.alias ?? s.id).join(", ");
          throw Object.assign(
            new Error(
              `Data source "${sourceId}" not found. Available: ${available}`,
            ),
            { status: 404 },
          );
        }
        return found;
      }

      if (sources.length === 1) return sources[0];

      const tableName = sql ? extractPrimaryTable(sql) : null;
      if (tableName) {
        for (const source of sources) {
          try {
            if (await dbPool.tableExists(source.dbPath, tableName)) {
              return source;
            }
          } catch {
            // source unreadable — skip
          }
        }
      }

      const aliases = sources.map((s) => `"${s.alias ?? s.id}"`).join(", ");
      const tableHint = tableName
        ? ` Table "${tableName}" was not found in any linked source.`
        : "";
      throw Object.assign(
        new Error(
          `Multiple data sources are linked (${aliases}) and the target could not be determined automatically.${tableHint} Pass sourceId to specify which source to use.`,
        ),
        { status: 400 },
      );
    }

    app.use(express.json());

    app.get("/api/db/schema", async (req, res) => {
      try {
        const appId = req.query["appId"] as string | undefined;
        if (!appId) {
          res.status(400).json({ error: "appId query param required" });
          return;
        }
        const appService = getAppService();
        const sources = await appService.listAppDataSources(appId);
        if (!sources.length) {
          res.json({ sources: [] });
          return;
        }

        const result = await Promise.all(
          sources.map(async (source) => {
            try {
              const schema = await dbPool.schema(source.dbPath);
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

    app.post("/api/db/query", async (req, res) => {
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

        const trimmed = sql.trim().toLowerCase();
        if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
          res.status(403).json({
            error: "Only SELECT (and WITH ... SELECT) queries are allowed",
          });
          return;
        }

        const appService = getAppService();
        const sources = await appService.listAppDataSources(appId);
        if (!sources.length) {
          res.status(404).json({
            error: `No data sources linked to app ${appId}. Use link_app_data_source first.`,
          });
          return;
        }

        let source: import("./services/AppService.js").AppDataSource;
        try {
          source = await resolveDataSource(sources, sourceId, sql);
        } catch (err) {
          const e = err as Error & { status?: number };
          res.status(e.status ?? 400).json({ error: e.message });
          return;
        }

        const result = await dbPool.query(appId, source.dbPath, sql, params);
        console.log(
          `[Gateway] /api/db/query app=${appId} source=${source.alias} rows=${result.count}`,
        );
        res.json({ ...result, source: source.alias });
      } catch (err) {
        console.error("[Gateway] /api/db/query error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });
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
    // ─────────────────────────────────────────────────────────────────────────

    app.post("/api/db/write", async (req, res) => {
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

        const appService = getAppService();
        const sources = await appService.listAppDataSources(appId);
        if (!sources.length) {
          res.status(404).json({
            error: `No data sources linked to app ${appId}. Use link_app_data_source first.`,
          });
          return;
        }

        let source: import("./services/AppService.js").AppDataSource;
        try {
          source = await resolveDataSource(sources, sourceId, sql);
        } catch (err) {
          const e = err as Error & { status?: number };
          res.status(e.status ?? 400).json({ error: e.message });
          return;
        }

        const result = await dbPool.write(appId, source.dbPath, sql, params);
        console.log(
          `[Gateway] /api/db/write app=${appId} source=${source.alias} changes=${result.changes}`,
        );
        res.json(result);
      } catch (err) {
        console.error("[Gateway] /api/db/write error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    // ── Mini-app SQLite DDL API ──────────────────────────────────────────────
    // Apps call: fetch('/api/db/exec', { method: 'POST', body: JSON.stringify({ appId, sql }) })
    // Only CREATE TABLE IF NOT EXISTS is allowed (safe schema bootstrapping).
    // ─────────────────────────────────────────────────────────────────────────
    app.post("/api/db/exec", async (req, res) => {
      try {
        const { appId, sql } = req.body as {
          appId?: string;
          sql?: string;
        };

        if (!appId || !sql) {
          res.status(400).json({ error: "appId and sql are required" });
          return;
        }

        const trimmed = sql.trim().toLowerCase();
        if (!trimmed.startsWith("create table if not exists")) {
          res.status(403).json({
            error:
              "Only CREATE TABLE IF NOT EXISTS is allowed on /api/db/exec.",
          });
          return;
        }

        const appService = getAppService();
        const sources = await appService.listAppDataSources(appId);
        if (!sources.length) {
          res.status(404).json({
            error: `No data sources linked to app ${appId}.`,
          });
          return;
        }

        const source = sources[0];
        await dbPool.exec(appId, source.dbPath, sql);
        console.log(
          `[Gateway] /api/db/exec app=${appId} source=${source.alias}`,
        );
        res.json({ success: true });
      } catch (err) {
        console.error("[Gateway] /api/db/exec error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

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
        const jobsService = getJobsService();
        const job = await jobsService.getJob(jobId);
        if (!job) {
          res.status(404).json({ error: `Job not found: ${jobId}` });
          return;
        }
        if (wait) {
          // Block until the job completes (use for short jobs only)
          const result = await jobsService.runJob(jobId, params);
          res.json({
            jobId,
            status: result.status,
            completedAt: result.completedAt,
            error: result.error,
            lastOutput: result.lastOutput,
          });
        } else {
          // Fire-and-forget: returns immediately, app polls /api/jobs/status/:jobId
          jobsService.runJob(jobId, params).catch((err: unknown) => {
            console.error(
              `[Gateway] /api/jobs/run background error for ${jobId}:`,
              err,
            );
          });
          res.json({ jobId, status: "running" });
        }
      } catch (err) {
        console.error("[Gateway] /api/jobs/run error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    // ── Mini-app Bash API ─────────────────────────────────────────────────────
    // Lets mini-apps run quick shell commands (the same capability agents have
    // via the bash tool).  Intended for lightweight backend calls like resetting
    // a DB row, calling a CLI, or reading a file — not long-running processes.
    //
    //  POST /api/bash/run
    //    body: { command: string, timeoutMs?: number (default 30000) }
    //    returns: { stdout, stderr, exitCode }
    // ─────────────────────────────────────────────────────────────────────────

    app.post("/api/bash/run", async (req, res) => {
      try {
        const { command, timeoutMs } = req.body as {
          command?: string;
          timeoutMs?: number;
        };
        if (!command || typeof command !== "string" || !command.trim()) {
          res.status(400).json({ error: "command is required" });
          return;
        }
        const timeout = Math.min(timeoutMs ?? 30_000, 120_000); // cap at 2 min
        const { exec } = await import("child_process");
        const result = await new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>((resolve) => {
          const proc = exec(
            command,
            { timeout, env: process.env, shell: "/bin/bash" },
            (error, stdout, stderr) => {
              resolve({
                stdout: stdout ?? "",
                stderr: stderr ?? "",
                exitCode: error?.code ?? (error ? 1 : 0),
              });
            },
          );
          // Ensure the child process is killed on timeout
          setTimeout(() => {
            try {
              proc.kill("SIGTERM");
            } catch {
              /* already done */
            }
          }, timeout);
        });
        console.log(
          `[Gateway] /api/bash/run exit=${result.exitCode} cmd="${command.slice(0, 80)}"`,
        );
        res.json(result);
      } catch (err) {
        console.error("[Gateway] /api/bash/run error:", err);
        res.status(500).json({ error: (err as Error).message });
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    // Serve mini-app files for iframe rendering in UI.
    // Supports on-the-fly TypeScript transpilation via esbuild.
    // Use RegExp route for Express/path-to-regexp compatibility.
    app.get(/^\/apps\/([^/]+)\/?(.*)$/, async (req, res) => {
      try {
        const appService = getAppService();
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

        let content = await appService.readAppFile(appId, requestedPath);
        if (content === null) {
          res.status(404).send("Not found");
          return;
        }

        const ext = path.extname(requestedPath).toLowerCase();

        // Transpile TypeScript files on-the-fly so agents can write .ts
        if (ext === ".ts" || ext === ".tsx") {
          try {
            const esbuild = await import("esbuild");
            const result = await esbuild.transform(content, {
              loader: ext === ".tsx" ? "tsx" : "ts",
              format: "esm",
              target: "es2020",
              sourcemap: "inline",
            });
            content = result.code;
          } catch (transpileError) {
            console.error(
              `[Gateway] TypeScript transpile error for ${requestedPath}:`,
              transpileError,
            );
            res
              .status(500)
              .send(
                `TypeScript compilation error:\n${(transpileError as Error).message}`,
              );
            return;
          }
        }

        const contentTypeByExt: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".ts": "text/javascript; charset=utf-8",
          ".tsx": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".svg": "image/svg+xml",
          ".txt": "text/plain; charset=utf-8",
        };
        res.setHeader(
          "Content-Type",
          contentTypeByExt[ext] ?? "text/plain; charset=utf-8",
        );
        res.send(content);
      } catch (error) {
        console.error("[Gateway] Failed to serve app file:", error);
        res.status(500).send("Failed to read app file");
      }
    });

    // Serve UI assets in production
    if (process.env.NODE_ENV === "production") {
      const uiPath = path.join(__dirname, "../ui");

      // Serve static files (CSS, JS, images)
      app.use(express.static(uiPath));

      // Catch-all route to serve index.html for SPA routing
      // Must be after static files so assets are served first
      app.use((_req, res) => {
        res.sendFile(path.join(uiPath, "index.html"));
      });

      console.log("[Gateway] Serving UI from:", uiPath);
    }

    // Start server with error handling
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

    // Handle shutdown
    const shutdown = async () => {
      console.log("[Gateway] Shutting down gracefully...");

      // Stop code indexing
      try {
        const { stopCodeIndexing } = await import(
          "./services/CodeIndexingService.js"
        );
        stopCodeIndexing();
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

      getJobsScheduler().stop();
      dbPool.terminate();
      server.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    getJobsScheduler().start();
    
    // Start code indexing after a delay (non-blocking)
    setTimeout(async () => {
      try {
        const { getApiKey } = await import('./utils/keyResolver.js');
        const paprKey = await getApiKey('PAPR_API_KEY');
        
        if (paprKey) {
          console.log('[Gateway] Starting code indexing...');
          const { ensureIndexingStarted } = await import('./services/CodeIndexingService.js');
          await ensureIndexingStarted(paprKey);
        } else {
          console.log('[Gateway] No PAPR_API_KEY found, skipping code indexing');
        }
      } catch (error) {
        console.error('[Gateway] Failed to start code indexing:', error);
      }
    }, 3000); // Wait 3 seconds after Gateway starts
  } catch (error) {
    console.error("[Gateway] Failed to start:", error);
    process.exit(1);
  }
}

// Start the gateway
startGateway();

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  console.error("[Gateway] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Gateway] Unhandled rejection:", reason);
});
