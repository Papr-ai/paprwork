/**
 * Claude-facing MCP endpoint, mounted on the Cloud App Host at /mcp (PR 0 spike).
 *
 * Stateless Streamable HTTP: every POST builds a fresh McpServer bound to the verified
 * caller. No session map to leak across users, and it scales horizontally on Cloud Run.
 *
 * Tools:
 *   {slug}_{view}  (model)    one per published card view (appTools.ts). Opens that card.
 *   papr_list_apps (model)    the caller's apps with cards, for discovery / beyond the tool cap.
 *   papr_open_app  (model)    open any published app by link (generic card).
 *   papr_continue_on_mac (model + app)  one-time papr:// link to pick up in the desktop app.
 *
 * Routes: /mcp (all the user's apps) and /mcp/a/{namespaceId}/{slug} (one app, for an
 * "Add to Claude" button on that app's page). Same sign-in, same audience.
 * Server instructions list the user's apps so Claude routes to them (routing.ts).
 *   papr_api       (app-only) the tunnel. Hidden from the model; only our cards call it.
 */
import { createHash } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { callerOf, createAuth0Verifier, registerProtectedResourceMetadata, type McpCaller } from "./auth.js";
import { dispatchTunnel, fetchPublishedCard, fetchPublishedCardsManifest, TunnelError, type TunnelMethod } from "./apiTunnel.js";
import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import { inputSchemaToZodShape, planAppTools, toolResultFor, appTitle, type AppToolSpec } from "./appTools.js";
import { loadClaudeCatalog, loadClaudeCatalogWithin, memoryAccessibleApps, parseCardsManifest, type CatalogDeps, type ClaudeApp } from "./catalog.js";
import { loadMcpEndpointConfig, MCP_PATH, protectedResourceMetadataUrl, type McpEndpointConfig } from "./config.js";
import { renderSpikeCardHtml } from "./spikeCard.js";
import { HandoffError, memoryHandoff, type CreateHandoff } from "./handoff.js";
import { memorySessionExchange, type McpSessionExchange } from "./session.js";
import { buildInstructions } from "./routing.js";
import { paprIcons, registerPaprIconRoutes } from "./paprIcon.js";

export interface AppScope {
  namespaceId: string;
  slug: string;
}

const SCOPE_PART = /^[A-Za-z0-9_-]{1,64}$/;

/** Connector URL that shows only one app in Claude. */
export function appConnectorUrl(cfg: McpEndpointConfig, namespaceId: string, slug: string): string {
  return `${cfg.resourceUrl}/a/${encodeURIComponent(namespaceId)}/${encodeURIComponent(slug)}`;
}

/**
 * Claude caches a ui:// resource by URI (across chats and reconnects), so every URI carries
 * a version: the generic card's content hash, and each app card's publish version.
 */
export const SPIKE_CARD_URI = `ui://papr/card/open-app.${createHash("sha256").update(renderSpikeCardHtml()).digest("hex").slice(0, 10)}.html`;

/**
 * Cards may show the app's own images (App Files): published objects come from the
 * Papr CDN, private ones as short-lived GCS signed URLs from /api/files/url.
 * Images/media only — cards still make no direct network calls (connect-src stays empty).
 */
export const CARD_CSP = { resourceDomains: ["https://files.papr.ai", "https://storage.googleapis.com"] };

/** Published card for one app view (built at publish into dist/cards/{view}.html). */
export function appCardUri(namespaceId: string, slug: string, view: string, rev?: string): string {
  const v = rev ? `@${createHash("sha256").update(rev).digest("hex").slice(0, 10)}` : "";
  return `ui://papr/app/${namespaceId}/${slug}/${view}${v}`;
}

/** Accepts https://apps.papr.ai/{namespaceId}/{slug}[/...] or explicit ids. */
export function parseAppRef(
  input: { url?: string; namespaceId?: string; slug?: string },
  known: Array<{ namespaceId: string; slug: string }> = [],
): {
  namespaceId: string;
  slug: string;
} {
  if (input.namespaceId && input.slug) return { namespaceId: input.namespaceId, slug: input.slug };
  if (input.slug && !input.url) {
    const want = input.slug.trim().toLowerCase();
    const hits = known.filter((a) => a.slug.toLowerCase() === want);
    if (hits.length === 1) return { namespaceId: hits[0].namespaceId, slug: hits[0].slug };
  }
  if (input.url) {
    const parts = new URL(input.url).pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return { namespaceId: parts[0], slug: parts[1] };
  }
  throw new TunnelError("Give the app's apps.papr.ai link, or its namespaceId and slug.");
}

export const MCP_INSTRUCTIONS =
  "Papr runs the user's ongoing work as apps (outreach, research, ops). Each app's tools open a live card in the chat; " +
  "changes only happen when the user presses a button on the card. Use papr_list_apps to see which apps the user has.";

export const FIRST_RUN_NOTE =
  "Your Papr workspace is ready. Install Papr on your Mac to build apps; they show up here as cards once published.";

export function buildMcpServer(
  cfg: McpEndpointConfig,
  caller: McpCaller,
  apps: ClaudeApp[] = [],
  deps: { handoff?: CreateHandoff } = {},
): McpServer {
  const server = new McpServer(
    { name: "papr", title: "Papr", version: "0.1.0", websiteUrl: "https://papr.ai", icons: paprIcons(cfg.resourceUrl) },
    { instructions: buildInstructions(MCP_INSTRUCTIONS, apps, appTitle) },
  );

  registerAppResource(server, "Papr app card", SPIKE_CARD_URI, { description: "Papr app card (spike)" }, async () => ({
    // Same CSP as app cards: papr_open_app hosts the app's own card inside this one.
    contents: [{ uri: SPIKE_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: renderSpikeCardHtml(), _meta: { ui: { csp: CARD_CSP } } }],
  }));

  // Per-app cards. PR 2 points generated per-app tools at these URIs.
  server.registerResource(
    "Papr app card",
    new ResourceTemplate("ui://papr/app/{namespaceId}/{slug}/{view}", { list: undefined }),
    { description: "A published Papr app card", mimeType: RESOURCE_MIME_TYPE },
    async (uri, vars) => {
      const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";
      const ref = { namespaceId: one(vars.namespaceId), slug: one(vars.slug) };
      const html = await fetchPublishedCard(cfg.loopbackPort, caller, ref, one(vars.view).split("@")[0]);
      if (html === null) throw new TunnelError("That card isn't published. Republish the app with Claude cards on.", 404);
      return { contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { csp: CARD_CSP } } }] };
    },
  );

  const tools = planAppTools(apps);
  for (const tool of tools) {
    registerAppTool(
      server,
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: inputSchemaToZodShape(tool.input, tool.requireInput),
        // Opening a card changes nothing; actions run from the card itself.
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: { ui: { resourceUri: appCardUri(tool.app.namespaceId, tool.app.slug, tool.view, tool.app.updatedAt) } },
      },
      async (args: Record<string, unknown>) => toolResultFor(tool, args, cfg.appsBaseUrl),
    );
  }

  server.registerTool(
    "papr_list_apps",
    {
      title: "List Papr apps",
      description: "List the user's Papr apps that can open as cards in this chat, with the tool for each card.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const rows = apps.map((app) => ({
        title: appTitle(app),
        summary: app.cards.summary ?? app.description ?? null,
        url: `${cfg.appsBaseUrl}/${app.namespaceId}/${app.slug}`,
        connectorUrl: appConnectorUrl(cfg, app.namespaceId, app.slug),
        tools: tools.filter((t) => t.app === app).map((t) => t.name),
      }));
      const firstRun = (caller.provisioned?.length ?? 0) > 0;
      const text = rows.length
        ? rows.map((r) => `- ${r.title}${r.summary ? `: ${r.summary}` : ""}\n  card tools: ${r.tools.join(", ") || "none loaded"}\n  link (for papr_open_app if a card tool is missing): ${r.url}`).join("\n")
        : firstRun
          ? FIRST_RUN_NOTE
          : "No Papr apps with Claude cards yet. Ask Pen in Papr to make an app work in Claude, then publish it.";
      return { content: [{ type: "text", text }], structuredContent: { apps: rows } };
    },
  );

  registerAppTool(
    server,
    "papr_open_app",
    {
      title: "Open a Papr app",
      description:
        "Show a published Papr app as a simple card, from its apps.papr.ai link or its slug (from papr_list_apps). Prefer the app's own card tools when they are loaded.",
      inputSchema: {
        url: z.string().url().optional().describe("https://apps.papr.ai/{namespaceId}/{slug}"),
        namespaceId: z.string().optional(),
        slug: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: SPIKE_CARD_URI } },
    },
    async (args) => {
      const ref = parseAppRef(args, apps);
      const access = await dispatchTunnel(cfg.loopbackPort, caller, { ...ref, method: "GET", path: "/api/access" });
      const body = (access.body ?? {}) as { canRead?: boolean };
      if (access.status >= 400 || !body.canRead) {
        return { isError: true, content: [{ type: "text", text: "You don't have access to that Papr app." }] };
      }
      const openUrl = `${cfg.appsBaseUrl}/${ref.namespaceId}/${ref.slug}`;
      const known = apps.find((a) => a.namespaceId === ref.namespaceId && a.slug === ref.slug);
      // The app's own card when it has one, even if its tools weren't in this conversation's list.
      const cards = known?.cards ?? parseCardsManifest(await fetchPublishedCardsManifest(cfg.loopbackPort, caller, ref).catch(() => null));
      const view = cards ? Object.keys(cards.views)[0] : undefined;
      const app = (known ?? { ...ref, cards }) as ClaudeApp;
      const title = known ? appTitle(known) : ref.slug;
      const card =
        cards && view
          ? { view, result: toolResultFor({ name: "", title: "", description: "", app, view, spec: cards.views[view] } as AppToolSpec, {}, cfg.appsBaseUrl).structuredContent }
          : undefined;
      return {
        content: [{ type: "text", text: card ? `Showing ${title} · ${cards!.views[view!].title ?? view}.` : `Opened ${title} from Papr.` }],
        structuredContent: {
          ...ref,
          title,
          openUrl,
          ...(card ? { card } : {}),
          ...(known?.cards.summary ?? known?.description ? { summary: known?.cards.summary ?? known?.description } : {}),
          ...(known?.cards.examples ? { examples: known.cards.examples } : {}),
          ...(known?.author ? { publisher: known.author } : {}),
          ...(known?.icon ? { icon: known.icon } : {}),
        },
      };
    },
  );

  registerAppTool(
    server,
    "papr_card_html",
    {
      title: "Papr app card (cards only)",
      description: "Internal: the published card page papr_open_app hosts. Not for direct use.",
      inputSchema: { namespaceId: z.string(), slug: z.string(), view: z.string().max(80) },
      _meta: { ui: { resourceUri: SPIKE_CARD_URI, visibility: ["app"] } },
    },
    async (args) => {
      try {
        const html = await fetchPublishedCard(cfg.loopbackPort, caller, { namespaceId: args.namespaceId, slug: args.slug }, args.view);
        if (html === null) return { isError: true, content: [{ type: "text", text: "No card published for that view." }] };
        return { content: [{ type: "text", text: "card" }], structuredContent: { html } };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
      }
    },
  );

  registerAppTool(
    server,
    "papr_api",
    {
      title: "Papr app API (cards only)",
      description: "Internal transport for Papr cards. Not for direct use.",
      inputSchema: {
        namespaceId: z.string(),
        slug: z.string(),
        method: z.enum(["GET", "POST"]),
        path: z.string().max(2200),
        body: z.unknown().optional(),
      },
      _meta: { ui: { resourceUri: SPIKE_CARD_URI, visibility: ["app"] } },
    },
    async (args) => {
      try {
        const out = await dispatchTunnel(cfg.loopbackPort, caller, {
          namespaceId: args.namespaceId,
          slug: args.slug,
          method: args.method as TunnelMethod,
          path: args.path,
          body: args.body,
        });
        return {
          isError: out.status >= 400,
          content: [{ type: "text", text: `HTTP ${out.status}` }],
          structuredContent: { status: out.status, body: out.body },
        };
      } catch (err) {
        const status = err instanceof TunnelError ? err.status : 502;
        const message = err instanceof Error ? err.message : "Tunnel failed";
        return { isError: true, content: [{ type: "text", text: message }], structuredContent: { status, body: { error: message } } };
      }
    },
  );

  const handoff = deps.handoff;
  if (handoff) {
    server.registerTool(
      "papr_continue_on_mac",
      {
        title: "Continue in Papr on Mac",
        description:
          "Give the user a one-time link that opens Papr on their Mac, signed in, optionally at a specific app. " +
          "Use when they want to build or edit an app, or run something that needs their Mac. The link works once, for 10 minutes.",
        inputSchema: {
          namespaceId: z.string().optional(),
          slug: z.string().optional().describe("App slug, to open that app"),
          view: z.string().optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          const link = await handoff(caller, {
            ...(args.namespaceId && args.slug ? { appNamespaceId: args.namespaceId, appSlug: args.slug } : {}),
            ...(args.view ? { view: args.view } : {}),
          });
          return {
            content: [{ type: "text", text: `Open Papr on your Mac: ${link.url}\n(One-time link, expires in 10 minutes. Don't have Papr? https://papr.ai/download)` }],
            structuredContent: { ...link, downloadUrl: "https://papr.ai/download" },
          };
        } catch (err) {
          const message = err instanceof HandoffError ? err.message : "Couldn't create a Mac link.";
          return { isError: true, content: [{ type: "text", text: message }] };
        }
      },
    );
  }

  return server;
}

/**
 * Only listing tools or calling a per-app tool needs the catalog. Card traffic
 * (papr_api, resources/read) skips it, keeping the hot path to one loopback hop.
 */
export function requestNeedsCatalog(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => {
    const method = (m as { method?: string } | null)?.method;
    // initialize: instructions name the user's apps. Cached per user, so reconnects are cheap.
    if (method === "tools/list" || method === "initialize") return true;
    if (method !== "tools/call") return false;
    const name = (m as { params?: { name?: string } }).params?.name;
    return name !== "papr_api" && name !== "papr_open_app" && name !== "papr_continue_on_mac";
  });
}

/**
 * Claude's connect check gives up after ~10s, so initialize never waits long on the app
 * list (its instructions only name apps). tools/list waits a little longer for per-app tools.
 */
export function catalogBudgetMs(body: unknown): number {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => (m as { method?: string } | null)?.method === "initialize") ? 2_500 : 7_000;
}

function isConnectNotification(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => (m as { method?: string } | null)?.method === "notifications/initialized");
}

export function defaultCatalogDeps(cfg: McpEndpointConfig, memoryBaseUrl: string): CatalogDeps {
  return {
    listAccessibleApps: memoryAccessibleApps(memoryBaseUrl),
    loadCardsManifest: (caller, ref) => fetchPublishedCardsManifest(cfg.loopbackPort, caller, ref),
  };
}

async function handleMcpPost(
  cfg: McpEndpointConfig,
  catalog: CatalogDeps,
  handoff: CreateHandoff | undefined,
  req: Request,
  res: Response,
  scope?: AppScope,
): Promise<void> {
  const caller = callerOf(req.auth);
  let apps: ClaudeApp[] = [];
  // Warm on connect-time notifications (not card traffic) so tools/list finds the catalog ready.
  if (!scope && isConnectNotification(req.body)) void loadClaudeCatalog(caller, catalog).catch(() => undefined);
  if (scope || requestNeedsCatalog(req.body)) {
    try {
      const r = await loadClaudeCatalogWithin(caller, catalog, catalogBudgetMs(req.body));
      apps = r.apps;
      if (!r.complete) console.warn(`[mcp] app catalog still loading; answered with ${apps.length} cached apps`);
    } catch (err) {
      // Papr's generic tools still work if the app list is down.
      console.warn("[mcp] app catalog unavailable:", (err as Error).message.slice(0, 160));
    }
  }
  if (scope) apps = apps.filter((a) => a.namespaceId === scope.namespaceId && a.slug === scope.slug);
  const server = buildMcpServer(cfg, caller, apps, { handoff });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  transport.onerror = (err) => console.warn(`[mcp] transport rejected request: ${err.message.slice(0, 200)} (protocol header: ${req.headers["mcp-protocol-version"] ?? "none"})`);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function registerMcpRoutes(
  app: Express,
  opts: {
    port: number;
    verifier?: OAuthTokenVerifier;
    config?: McpEndpointConfig;
    catalog?: CatalogDeps;
    memoryBaseUrl?: string;
    exchange?: McpSessionExchange;
    /** null disables the Mac handoff tool. */
    handoff?: CreateHandoff | null;
  },
): McpEndpointConfig {
  const cfg = opts.config ?? loadMcpEndpointConfig(opts.port);
  const memoryBaseUrl = opts.memoryBaseUrl ?? getMemoryServerBaseUrl();
  const catalog = opts.catalog ?? defaultCatalogDeps(cfg, memoryBaseUrl);
  const exchange = opts.exchange ?? (cfg.serviceKey ? memorySessionExchange(memoryBaseUrl, cfg.serviceKey) : undefined);
  if (!exchange) console.warn("[mcp] PAPR_MCP_SERVICE_KEY unset: using the Auth0 claims bridge (spike only).");
  // The handoff needs a memory-minted session; the claims bridge's Parse session works too.
  const handoff = opts.handoff === null ? undefined : (opts.handoff ?? memoryHandoff(memoryBaseUrl));
  registerProtectedResourceMetadata(app, cfg);
  registerPaprIconRoutes(app);
  const bearer = requireBearerAuth({
    verifier: opts.verifier ?? createAuth0Verifier(cfg, exchange),
    resourceMetadataUrl: protectedResourceMetadataUrl(cfg),
  });
  app.post(MCP_PATH, bearer, (req, res, next: NextFunction) => {
    handleMcpPost(cfg, catalog, handoff, req, res).catch(next);
  });
  app.post(`${MCP_PATH}/a/:namespaceId/:slug`, bearer, (req, res, next: NextFunction) => {
    const { namespaceId, slug } = req.params as Record<string, string>;
    if (!SCOPE_PART.test(namespaceId) || !SCOPE_PART.test(slug)) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown Papr app" }, id: null });
      return;
    }
    handleMcpPost(cfg, catalog, handoff, req, res, { namespaceId, slug }).catch(next);
  });
  // Stateless server: no standalone SSE stream and no sessions to delete.
  const notAllowed = (_req: Request, res: Response): void => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  for (const p of [MCP_PATH, `${MCP_PATH}/a/:namespaceId/:slug`]) {
    app.get(p, notAllowed);
    app.delete(p, notAllowed);
  }
  return cfg;
}
