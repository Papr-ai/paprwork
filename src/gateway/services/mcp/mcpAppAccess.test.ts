import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { McpAppAccess, resolveMcpCaller } from "./mcpAppAccess.js";
import { registerMcpRoutes, setMcpAppAccess } from "./mcpRoutes.js";
import { initializeMcpConnectionService, getMcpConnectionService } from "./McpConnectionService.js";
import { createMemoryMcpCredentialStore } from "./mcpCredentialStore.js";
import { ToolRegistry } from "../../../core/agents/ToolRegistry.js";

const APP = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

describe("resolveMcpCaller", () => {
  it("identifies apps by Referer and Host", () => {
    expect(resolveMcpCaller({ referer: `http://localhost:18789/apps/${APP}/index.html` })).toEqual({ kind: "app", appId: APP });
    expect(resolveMcpCaller({ host: `app-${APP}.localhost:18789` })).toEqual({ kind: "app", appId: APP });
  });
  it("refuses foreign origins, sandboxed frames and Host/Referer mismatch", () => {
    expect(resolveMcpCaller({ origin: "https://evil.example" }).kind).toBe("forbidden");
    expect(resolveMcpCaller({ origin: "null", "sec-fetch-site": "same-origin" }).kind).toBe("forbidden");
    expect(
      resolveMcpCaller({ host: `app-${APP}.localhost:18789`, referer: `http://localhost:18789/apps/${OTHER}/` }).kind,
    ).toBe("forbidden");
  });
  it("browser without app identity is ui; plain/Node process is local", () => {
    expect(resolveMcpCaller({ host: "127.0.0.1:18789", "sec-fetch-mode": "cors" })).toEqual({ kind: "local" });
    expect(resolveMcpCaller({ origin: "http://localhost:18789", "sec-fetch-site": "same-origin" })).toEqual({ kind: "ui" });
    expect(resolveMcpCaller({ host: "127.0.0.1:18789" })).toEqual({ kind: "local" });
  });
});

describe("/api/mcp/* app gate", () => {
  let root: string;
  let base: string;
  let server: http.Server;
  let prompts: string[] = [];
  let approve = true;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-access-"));
    await fs.mkdir(path.join(root, "apps", APP), { recursive: true });
    await fs.writeFile(path.join(root, "apps", APP, "connections.json"), JSON.stringify({ connections: ["linear"] }));
    initializeMcpConnectionService({
      store: createMemoryMcpCredentialStore(),
      openBrowser: () => {},
      customServersFile: path.join(root, "servers.json"),
    });
    const svc = getMcpConnectionService()!;
    // No real server: answer tool calls from a stub.
    (svc as unknown as { callTool: unknown }).callTool = async (_s: string, tool: string) => ({
      content: [{ type: "text", text: `ok:${tool}` }],
    });
    setMcpAppAccess(
      new McpAppAccess({
        paprRoot: () => root,
        appTitle: async () => "Test App",
        askUser: async ({ serverId }) => {
          prompts.push(serverId);
          return approve;
        },
      }),
    );
    const app = express();
    app.use(express.json());
    registerMcpRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    prompts = [];
  });

  const fromApp = (id = APP) => ({ referer: `http://localhost:18789/apps/${id}/index.html`, "sec-fetch-site": "same-origin" });
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("app sees only its declared servers, without urls or errors", async () => {
    const r = await fetch(`${base}/api/mcp/servers`, { headers: fromApp() });
    const j = (await r.json()) as { servers: Array<{ id: string; url?: string }> };
    expect(j.servers.map((s: { id: string }) => s.id)).toEqual(["linear"]);
    expect(j.servers[0].url).toBeUndefined();
  });

  it("refuses undeclared servers without prompting", async () => {
    const r = await post("/api/mcp/call", { server: "notion", tool: "search" }, fromApp());
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toContain("connections.json");
    expect(prompts).toEqual([]);
  });

  it("denied approval → 403; approved → call goes through and is remembered", async () => {
    approve = false;
    expect((await post("/api/mcp/call", { server: "linear", tool: "list_issues" }, fromApp())).status).toBe(403);
    approve = true;
    const ok = await post("/api/mcp/call", { server: "linear", tool: "list_issues" }, fromApp());
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { text: string }).text).toBe("ok:list_issues");
    await post("/api/mcp/call", { server: "linear", tool: "get_issue" }, fromApp());
    expect(prompts).toEqual(["linear", "linear"]); // denied once, approved once, then cached
  });

  it("apps cannot manage connections", async () => {
    expect((await post("/api/mcp/servers/linear/disconnect", {}, fromApp())).status).toBe(403);
    expect((await post("/api/mcp/servers", { url: "https://x.example/mcp" }, fromApp())).status).toBe(403);
  });

  it("another app has no grant from this one", async () => {
    await fs.mkdir(path.join(root, "apps", OTHER), { recursive: true });
    const r = await post("/api/mcp/call", { server: "linear", tool: "list_issues" }, fromApp(OTHER));
    expect(r.status).toBe(403);
  });

  it("browser without identity cannot call tools; local process can", async () => {
    const ui = await post("/api/mcp/call", { server: "linear", tool: "x" }, { origin: "http://localhost:18789", "sec-fetch-site": "same-origin" });
    expect(ui.status).toBe(403);
    const local = await post("/api/mcp/call", { server: "linear", tool: "x" });
    expect(local.status).toBe(200);
  });
});

describe("ToolRegistry mcp: opt-in", () => {
  const tool = (id: string) => ({ id, description: id }) as never;
  const reg = new ToolRegistry();
  for (const id of ["bash", "linear__list_issues", "linear__get_issue", "notion__search", "fake_tool"]) reg.register(tool(id));

  it("fixed allowlists exclude MCP tools unless opted in", () => {
    expect(Object.keys(reg.getToolsForMastra(["bash"]))).toEqual(["bash"]);
    expect(Object.keys(reg.getToolsForMastra(["bash", "mcp:linear"])).sort()).toEqual(["bash", "linear__get_issue", "linear__list_issues"]);
    expect(Object.keys(reg.getToolsForMastra(["mcp:*"])).sort()).toEqual(["linear__get_issue", "linear__list_issues", "notion__search"]);
  });

  it("no allowlist still means everything", () => {
    expect(Object.keys(reg.getToolsForMastra()).length).toBe(5);
  });
});

