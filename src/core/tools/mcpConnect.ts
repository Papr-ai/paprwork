/**
 * connect_mcp — one-click OAuth sign-in to remote MCP servers (Linear, Notion,
 * Atlassian, Sentry, Stripe, …). After connect, the server's tools appear as
 * `<server>__<tool>` and are reachable via find_tools / run_deferred_tool.
 *
 * SECURITY: never returns tokens. Credentials stay in the keychain.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolResult } from "../types/index.js";

const ok = (data: unknown, started: number): ToolResult => ({
  success: true,
  data,
  duration: performance.now() - started,
  timestamp: new Date().toISOString(),
});
const fail = (error: string, started: number): ToolResult => ({
  success: false,
  error,
  duration: performance.now() - started,
  timestamp: new Date().toISOString(),
});

export const connectMcpTool = createTool({
  id: "connect_mcp",
  description: `Connect the user's SaaS accounts via remote MCP servers with one-click OAuth (browser consent, no API keys).

Built-in servers: linear, notion, atlassian (Jira+Confluence), sentry, asana, stripe, cloudflare, intercom, canva, vercel. (github, hubspot: not yet — no dynamic client registration.) Any other remote MCP server: pass its https:// URL as server.

Actions:
- status: list servers + connection state (default). Pass server for one.
- connect: opens the browser consent page. Returns immediately with state "awaiting_user"; tell the user to approve in the browser, then call status (or just use the tools) — connected tools appear as <server>__<tool>, e.g. linear__list_issues.
- disconnect: sign out and delete stored credentials.
- tools: list tool ids for a connected server (call them with run_deferred_tool, or find_tools for schemas).

Use when the user asks about data in one of these services and it isn't connected, or says "connect Linear/Notion/…". Prefer this over asking for API keys for these services.`,
  inputSchema: z.object({
    action: z.enum(["status", "connect", "disconnect", "tools"]).default("status"),
    server: z
      .string()
      .optional()
      .describe("Server id (linear, notion, …), display name, or an https:// MCP URL. Required except for status."),
  }),
  execute: async (inputData: unknown): Promise<ToolResult> => {
    const started = performance.now();
    const raw = (inputData as { context?: unknown })?.context ?? inputData;
    const args = raw as { action?: string; server?: string };
    const action = args.action ?? "status";
    const { getMcpConnectionService } = await import(
      "../../gateway/services/mcp/McpConnectionService.js"
    );
    const svc = getMcpConnectionService();
    if (!svc) return fail("MCP connections are not available in this runtime (desktop only for now).", started);

    try {
      if (action === "status") {
        const target = args.server ? (await svc.resolveServer(args.server)).id : undefined;
        const servers = await svc.status(target);
        return ok(
          servers.map(({ toolNames: _t, ...s }) => s),
          started,
        );
      }
      if (!args.server) return fail(`server is required for action "${action}"`, started);

      if (action === "connect") {
        const { status } = await svc.connect(args.server);
        if (status.state === "connected") {
          return ok({ ...status, toolNames: undefined, message: `${status.name} is connected — ${status.toolCount} tools available as ${status.id}__*.` }, started);
        }
        return ok(
          {
            id: status.id,
            name: status.name,
            state: status.state,
            authUrl: status.authUrl,
            message: `Opened ${status.name} sign-in in the browser. Ask the user to approve, then check status. If the browser didn't open, share authUrl.`,
          },
          started,
        );
      }
      if (action === "disconnect") {
        const def = await svc.resolveServer(args.server);
        const s = await svc.disconnect(def.id);
        return ok({ id: s.id, state: s.state, message: `${s.name} disconnected and credentials removed.` }, started);
      }
      if (action === "tools") {
        const def = await svc.resolveServer(args.server);
        const [s] = await svc.status(def.id);
        if (s.state !== "connected") {
          const restored = await svc.ensure(def.id);
          if (restored.state !== "connected") return fail(`${def.name} is ${restored.state}. Use action="connect".`, started);
          return ok({ id: def.id, tools: restored.toolNames }, started);
        }
        return ok({ id: def.id, tools: s.toolNames }, started);
      }
      return fail(`Unknown action "${action}"`, started);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), started);
    }
  },
});

export const mcpConnectTools = [connectMcpTool];
