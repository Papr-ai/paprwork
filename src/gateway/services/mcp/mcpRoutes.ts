/**
 * /api/mcp/* — Settings UI, mini-apps (papr-connect SDK) and jobs.
 *
 *   GET    /api/mcp/servers                 status (apps: only their declared servers)
 *   POST   /api/mcp/servers                 { url, name? } add a custom server        [ui/local]
 *   DELETE /api/mcp/servers/:id             remove a custom server                    [ui/local]
 *   POST   /api/mcp/servers/:id/connect     start OAuth (returns authUrl)             [apps: declared + approved]
 *   POST   /api/mcp/servers/:id/cancel      abandon an in-flight sign-in              [apps: declared]
 *   POST   /api/mcp/servers/:id/disconnect  sign out + delete credentials             [ui/local]
 *   GET    /api/mcp/servers/:id/tools       tool list                                  [apps: declared + approved]
 *   POST   /api/mcp/call                    { server, tool, arguments }               [local; apps: declared + approved]
 *
 * Caller identity and the per-app grant live in mcpAppAccess.ts. Tokens are
 * never returned to anyone.
 */
import { assertOrgAllows, OrgPolicyBlockedError, registerOrgPolicyRoutes } from "./mcpOrgPolicy.js";
import { PenAccessDeniedError } from "./mcpPenAccess.js";
import type { Express, Request, Response } from "express";
import { getMcpConnectionService, type McpConnectionService, type McpServerStatus } from "./McpConnectionService.js";
import { formatMcpResult } from "./mcpToolAdapter.js";
import { McpAccessError, resolveMcpCaller, type McpAppAccess, type McpCaller } from "./mcpAppAccess.js";

let access: McpAppAccess | null = null;

/** Wire the per-app permission gate (gateway startup). Without it, app callers are refused. */
export function setMcpAppAccess(a: McpAppAccess): void {
  access = a;
}

function svcOr503(res: Response): McpConnectionService | null {
  const svc = getMcpConnectionService();
  if (!svc) res.status(503).json({ error: "MCP connections not initialized" });
  return svc;
}

const pid = (req: Request): string => String(req.params.id ?? "").trim().toLowerCase();
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function fail(res: Response, e: unknown, fallback = 400): void {
  const pen = e instanceof PenAccessDeniedError;
  const status = e instanceof McpAccessError || e instanceof OrgPolicyBlockedError || pen ? e.status : fallback;
  const code = e instanceof OrgPolicyBlockedError ? "org_policy" : pen ? "pen_access" : undefined;
  res.status(status).json({ error: msg(e), ...(code ? { code } : {}) });
}

/** Resolve the caller; refuse foreign origins and (optionally) app callers. */
function caller(req: Request, res: Response, opts: { allowApps: boolean; allowUi?: boolean }): McpCaller | null {
  const c = resolveMcpCaller(req.headers);
  if (c.kind === "forbidden") {
    res.status(403).json({ error: c.reason });
    return null;
  }
  if (c.kind === "app" && !opts.allowApps) {
    res.status(403).json({ error: "Mini-apps cannot manage connections. Ask the user to do it in Settings → Connections." });
    return null;
  }
  if (c.kind === "ui" && opts.allowUi === false) {
    res.status(403).json({ error: "Not allowed from a browser context without an app identity." });
    return null;
  }
  if (c.kind === "app" && !access) {
    res.status(503).json({ error: "Connection permissions not initialized" });
    return null;
  }
  return c;
}

async function serverName(svc: McpConnectionService, id: string): Promise<string> {
  return (await svc.getServer(id))?.name ?? id;
}

/** Strip details an app has no business seeing. */
function appView(s: McpServerStatus) {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    state: s.state,
    toolCount: s.toolCount,
    requiresClientId: s.requiresClientId,
    ...(s.state === "awaiting_user" && s.authUrl ? { authUrl: s.authUrl } : {}),
  };
}

export function registerMcpRoutes(app: Express): void {
  registerOrgPolicyRoutes(app, (req, res) => Boolean(caller(req, res, { allowApps: false })));

  app.get("/api/mcp/servers", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    const c = caller(req, res, { allowApps: true });
    if (!c) return;
    const all = await svc.status();
    if (c.kind !== "app") return void res.json({ servers: all });
    const declared = new Set(await access!.declared(c.appId));
    res.json({ servers: all.filter((s) => declared.has(s.id)).map(appView), declared: [...declared] });
  });

  app.post("/api/mcp/servers", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc || !caller(req, res, { allowApps: false })) return;
    try {
      const def = await svc.addCustomServer({ url: String(req.body?.url ?? ""), name: req.body?.name });
      res.json({ server: (await svc.status(def.id))[0] });
    } catch (e) {
      fail(res, e);
    }
  });

  app.delete("/api/mcp/servers/:id", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc || !caller(req, res, { allowApps: false })) return;
    try {
      const def = await svc.getServer(pid(req));
      if (!def?.custom) return void res.status(400).json({ error: "Only custom servers can be removed" });
      await svc.removeCustomServer(def.id);
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/mcp/servers/:id/connect", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    const c = caller(req, res, { allowApps: true });
    if (!c) return;
    const id = pid(req);
    try {
      // An app opening consent pages must be something the user agreed to,
      // or any app could spam browser tabs.
      if (c.kind === "app") await access!.assertGranted(c.appId, id, await serverName(svc, id));
      await assertOrgAllows(id, await serverName(svc, id));
      const { status } = await svc.connect(id);
      res.json({ server: c.kind === "app" ? appView(status) : status });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/mcp/servers/:id/cancel", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    const c = caller(req, res, { allowApps: true });
    if (!c) return;
    try {
      if (c.kind === "app") await access!.assertDeclared(c.appId, pid(req));
      const s = await svc.cancelSignIn(pid(req));
      res.json({ server: c.kind === "app" ? appView(s) : s });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/mcp/servers/:id/disconnect", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc || !caller(req, res, { allowApps: false })) return;
    try {
      const s = await svc.disconnect(pid(req));
      access?.revokeServer(s.id);
      res.json({ server: s });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/mcp/servers/:id/tools", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    const c = caller(req, res, { allowApps: true });
    if (!c) return;
    const id = pid(req);
    try {
      if (c.kind === "app") await access!.assertGranted(c.appId, id, await serverName(svc, id));
      const s = await svc.ensure(id);
      if (s.state !== "connected") {
        return void res.status(409).json({ error: `${s.name} is not connected (${s.state})`, state: s.state });
      }
      res.json({ server: s.id, tools: await svc.listTools(id) });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/mcp/call", async (req: Request, res: Response) => {
    const svc = svcOr503(res);
    if (!svc) return;
    // The desktop UI never calls tools; refusing it also catches an app that
    // hid its identity (Referer suppressed) — it still reads as a browser.
    const c = caller(req, res, { allowApps: true, allowUi: false });
    if (!c) return;
    const server = String(req.body?.server ?? "").trim().toLowerCase();
    const tool = String(req.body?.tool ?? "");
    const args = req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {};
    if (!server || !tool) return void res.status(400).json({ error: "server and tool are required" });
    try {
      if (c.kind === "app") await access!.assertGranted(c.appId, server, await serverName(svc, server));
      const result = await svc.callTool(server, tool, args);
      res.json({
        isError: Boolean(result.isError),
        text: formatMcpResult(result),
        structuredContent: result.structuredContent ?? null,
      });
    } catch (e) {
      fail(res, e, 502);
    }
  });
}
