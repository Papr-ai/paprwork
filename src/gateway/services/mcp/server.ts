/**
 * Claude-facing MCP endpoint, mounted on the Cloud App Host at /mcp (PR 0 spike).
 *
 * Stateless Streamable HTTP: every POST builds a fresh McpServer bound to the verified
 * caller. No session map to leak across users, and it scales horizontally on Cloud Run.
 *
 * Tools in the spike:
 *   papr_open_app  (model)    open a published Papr app as a card. Carries _meta.ui.resourceUri.
 *   papr_api       (app-only) the tunnel. Hidden from the model; only our cards call it.
 */
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
import { dispatchTunnel, fetchPublishedCard, TunnelError, type TunnelMethod } from "./apiTunnel.js";
import { loadMcpEndpointConfig, MCP_PATH, protectedResourceMetadataUrl, type McpEndpointConfig } from "./config.js";
import { renderSpikeCardHtml } from "./spikeCard.js";

export const SPIKE_CARD_URI = "ui://papr/spike/app-card.html";

/** Published card for one app view (built at publish into dist/cards/{view}.html). */
export function appCardUri(namespaceId: string, slug: string, view: string): string {
  return `ui://papr/app/${namespaceId}/${slug}/${view}`;
}

/** Accepts https://apps.papr.ai/{namespaceId}/{slug}[/...] or explicit ids. */
export function parseAppRef(input: { url?: string; namespaceId?: string; slug?: string }): {
  namespaceId: string;
  slug: string;
} {
  if (input.namespaceId && input.slug) return { namespaceId: input.namespaceId, slug: input.slug };
  if (input.url) {
    const parts = new URL(input.url).pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return { namespaceId: parts[0], slug: parts[1] };
  }
  throw new TunnelError("Give the app's apps.papr.ai link, or its namespaceId and slug.");
}

export function buildMcpServer(cfg: McpEndpointConfig, caller: McpCaller): McpServer {
  const server = new McpServer(
    { name: "papr", title: "Papr", version: "0.0.1" },
    { instructions: "Papr runs ongoing work as apps. Use papr_open_app to show a user's Papr app as a card." },
  );

  registerAppResource(server, "Papr app card", SPIKE_CARD_URI, { description: "Papr app card (spike)" }, async () => ({
    contents: [{ uri: SPIKE_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: renderSpikeCardHtml() }],
  }));

  // Per-app cards. PR 2 points generated per-app tools at these URIs.
  server.registerResource(
    "Papr app card",
    new ResourceTemplate("ui://papr/app/{namespaceId}/{slug}/{view}", { list: undefined }),
    { description: "A published Papr app card", mimeType: RESOURCE_MIME_TYPE },
    async (uri, vars) => {
      const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";
      const ref = { namespaceId: one(vars.namespaceId), slug: one(vars.slug) };
      const html = await fetchPublishedCard(cfg.loopbackPort, caller, ref, one(vars.view));
      if (html === null) throw new TunnelError("That card isn't published. Republish the app with Claude cards on.", 404);
      return { contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: html }] };
    },
  );

  registerAppTool(
    server,
    "papr_open_app",
    {
      title: "Open a Papr app",
      description:
        "Show one of the user's published Papr apps as an interactive card. Pass the app's apps.papr.ai link.",
      inputSchema: {
        url: z.string().url().optional().describe("https://apps.papr.ai/{namespaceId}/{slug}"),
        namespaceId: z.string().optional(),
        slug: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: SPIKE_CARD_URI } },
    },
    async (args) => {
      const ref = parseAppRef(args);
      const access = await dispatchTunnel(cfg.loopbackPort, caller, { ...ref, method: "GET", path: "/api/access" });
      const body = (access.body ?? {}) as { canRead?: boolean };
      if (access.status >= 400 || !body.canRead) {
        return { isError: true, content: [{ type: "text", text: "You don't have access to that Papr app." }] };
      }
      const openUrl = `${cfg.appsBaseUrl}/${ref.namespaceId}/${ref.slug}`;
      return {
        content: [{ type: "text", text: `Opened ${ref.slug} from Papr.` }],
        structuredContent: { ...ref, title: ref.slug, openUrl, email: caller.email ?? null },
      };
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

  return server;
}

async function handleMcpPost(cfg: McpEndpointConfig, req: Request, res: Response): Promise<void> {
  const caller = callerOf(req.auth);
  const server = buildMcpServer(cfg, caller);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export function registerMcpRoutes(
  app: Express,
  opts: { port: number; verifier?: OAuthTokenVerifier; config?: McpEndpointConfig },
): McpEndpointConfig {
  const cfg = opts.config ?? loadMcpEndpointConfig(opts.port);
  registerProtectedResourceMetadata(app, cfg);
  const bearer = requireBearerAuth({
    verifier: opts.verifier ?? createAuth0Verifier(cfg),
    resourceMetadataUrl: protectedResourceMetadataUrl(cfg),
  });
  app.post(MCP_PATH, bearer, (req, res, next: NextFunction) => {
    handleMcpPost(cfg, req, res).catch(next);
  });
  // Stateless server: no standalone SSE stream and no sessions to delete.
  const notAllowed = (_req: Request, res: Response): void => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get(MCP_PATH, notAllowed);
  app.delete(MCP_PATH, notAllowed);
  return cfg;
}
