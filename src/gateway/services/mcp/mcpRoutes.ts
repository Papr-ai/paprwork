/**
 * /api/mcp/* — Settings UI + jobs access to MCP connections.
 *
 *   GET    /api/mcp/servers                 status of every server
 *   POST   /api/mcp/servers                 { url, name? } add a custom server
 *   DELETE /api/mcp/servers/:id             remove a custom server
 *   POST   /api/mcp/servers/:id/connect     start OAuth (returns authUrl)
 *   POST   /api/mcp/servers/:id/disconnect  sign out + delete credentials
 *   GET    /api/mcp/servers/:id/tools       tool list (name, description, schema)
 *   POST   /api/mcp/call                    { server, tool, arguments } — for jobs
 *
 * Tokens are never returned. Gateway is localhost-only, same as other /api routes.
 */

import type { Express, Request, Response } from "express";
import { getMcpConnectionService, type McpConnectionService } from "./McpConnectionService.js";
import { formatMcpResult } from "./mcpToolAdapter.js";

function svcOr503(res: Response): McpConnectionService | null {
  const svc = getMcpConnectionService();
  if (!svc) res.status(503).json({ error: "MCP connections not initialized" });
  return svc;
}

const pid = (req: Request): string => String(req.params.id ?? "");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerMcpRoutes(app: Express): void {
  app.get("/api/mcp/servers", async (_req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    res.json({ servers: await svc.status() });
  });

  app.post("/api/mcp/servers", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    try {
      const def = await svc.addCustomServer({ url: String(req.body?.url ?? ""), name: req.body?.name });
      res.json({ server: (await svc.status(def.id))[0] });
    } catch (e) {
      res.status(400).json({ error: msg(e) });
    }
  });

  app.delete("/api/mcp/servers/:id", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    try {
      const def = await svc.getServer(pid(req));
      if (!def?.custom) return void res.status(400).json({ error: "Only custom servers can be removed" });
      await svc.removeCustomServer(def.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: msg(e) });
    }
  });

  app.post("/api/mcp/servers/:id/connect", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    try {
      const { status } = await svc.connect(pid(req));
      res.json({ server: status });
    } catch (e) {
      res.status(400).json({ error: msg(e) });
    }
  });

  app.post("/api/mcp/servers/:id/disconnect", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    try {
      res.json({ server: await svc.disconnect(pid(req)) });
    } catch (e) {
      res.status(400).json({ error: msg(e) });
    }
  });

  app.get("/api/mcp/servers/:id/tools", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    try {
      const s = await svc.ensure(pid(req));
      if (s.state !== "connected") return void res.status(409).json({ error: `Server is ${s.state}`, server: s });
      res.json({ server: s.id, tools: s.toolNames });
    } catch (e) {
      res.status(400).json({ error: msg(e) });
    }
  });

  app.post("/api/mcp/call", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    const server = String(req.body?.server ?? "");
    const tool = String(req.body?.tool ?? "");
    const args = req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {};
    if (!server || !tool) return void res.status(400).json({ error: "server and tool are required" });
    try {
      const result = await svc.callTool(server, tool, args);
      res.json({
        isError: Boolean(result.isError),
        text: formatMcpResult(result),
        structuredContent: result.structuredContent ?? null,
      });
    } catch (e) {
      res.status(502).json({ error: msg(e) });
    }
  });
}
