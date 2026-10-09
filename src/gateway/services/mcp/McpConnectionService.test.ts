/**
 * End-to-end OAuth against a real local MCP server: the SDK's own server-side
 * auth router (metadata, DCR, authorize, token) plus a Streamable HTTP MCP
 * endpoint guarded by bearer auth. The "browser" is a fetch that follows the
 * authorize redirect to our loopback callback — exactly what a user click does.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { McpConnectionService } from "./McpConnectionService.js";
import { createMemoryMcpCredentialStore } from "./mcpCredentialStore.js";
import { mcpAgentToolId } from "./mcpToolAdapter.js";

let base = "";
let server: http.Server;
const registered: string[] = [];
let tokenIssues = 0;

function fakeAuthProvider(): OAuthServerProvider {
  const clients = new Map<string, OAuthClientInformationFull>();
  const codes = new Map<string, { clientId: string; challenge: string }>();
  const tokens = new Map<string, { clientId: string; expiresAt: number }>();
  const refreshTokens = new Map<string, string>();
  const clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => clients.get(id),
    registerClient: (c) => {
      const full = { ...c, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
      clients.set(full.client_id, full);
      registered.push(full.client_id);
      return full;
    },
  };
  const issue = (clientId: string) => {
    tokenIssues++;
    const access = randomUUID();
    const refresh = randomUUID();
    tokens.set(access, { clientId, expiresAt: Date.now() + 3600_000 });
    refreshTokens.set(refresh, clientId);
    return { access_token: access, token_type: "bearer", expires_in: 3600, refresh_token: refresh };
  };
  return {
    clientsStore,
    async authorize(client, params, res) {
      const code = randomUUID();
      codes.set(code, { clientId: client.client_id, challenge: params.codeChallenge });
      const u = new URL(params.redirectUri);
      u.searchParams.set("code", code);
      if (params.state) u.searchParams.set("state", params.state);
      res.redirect(u.toString());
    },
    async challengeForAuthorizationCode(_c, code) {
      return codes.get(code)!.challenge;
    },
    async exchangeAuthorizationCode(client, code) {
      const c = codes.get(code);
      if (!c || c.clientId !== client.client_id) throw new Error("bad code");
      codes.delete(code);
      return issue(client.client_id);
    },
    async exchangeRefreshToken(client, refresh) {
      if (refreshTokens.get(refresh) !== client.client_id) throw new Error("bad refresh");
      refreshTokens.delete(refresh);
      return issue(client.client_id);
    },
    async verifyAccessToken(token) {
      const t = tokens.get(token);
      if (!t) throw new InvalidTokenError("invalid token");
      return { token, clientId: t.clientId, scopes: [], expiresAt: Math.floor(t.expiresAt / 1000) };
    },
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  const provider = fakeAuthProvider();
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(base), resourceServerUrl: new URL(`${base}/mcp`) }));
  app.post(
    "/mcp",
    requireBearerAuth({ verifier: provider, resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp` }),
    async (req, res) => {
      const mcp = new McpServer({ name: "fake-linear", version: "1" });
      mcp.registerTool(
        "list_issues",
        { description: "List issues", inputSchema: { team: z.string() }, annotations: { readOnlyHint: true } },
        async ({ team }) => ({ content: [{ type: "text", text: `issues for ${team}: ENG-1, ENG-2` }] }),
      );
      // No annotations: Pen must treat it as a change.
      mcp.registerTool("create_issue", { description: "Create an issue", inputSchema: { title: z.string() } }, async ({ title }) => ({
        content: [{ type: "text", text: `created ${title}` }],
      }));
      mcp.registerTool(
        "delete_issue",
        { description: "Delete an issue", inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
        async ({ id }) => ({ content: [{ type: "text", text: `deleted ${id}` }] }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("McpConnectionService (native MCP OAuth)", () => {
  const store = createMemoryMcpCredentialStore();
  const registry = new Map<string, { id: string; description: string; execute: (a: unknown) => Promise<unknown> }>();
  // "Browser": follow the authorize redirect to the loopback callback.
  const browser = async (url: string) => {
    let next = url;
    for (let i = 0; i < 5; i++) {
      const r = await fetch(next, { redirect: "manual" });
      const loc = r.headers.get("location");
      if (!loc) return;
      next = new URL(loc, next).toString();
    }
  };
  const svc = new McpConnectionService({
    store,
    openBrowser: (u) => void browser(u),
    customServersFile: path.join(os.tmpdir(), `mcp-servers-${randomUUID()}.json`),
  });
  svc.setToolSink({
    register: (t) => registry.set(t.id, t),
    unregister: (id) => registry.delete(id),
  });

  it("registers dynamically, completes PKCE via loopback, and exposes tools", async () => {
    const def = await svc.addCustomServer({ url: `https://placeholder.invalid/mcp`, name: "Fake Linear", id: "fakelinear" });
    // Point at the local http server (custom servers require https via the public API).
    def.url = `${base}/mcp`;
    const { completion } = await svc.connect("fakelinear");
    const status = await completion;
    expect(status.state).toBe("connected");
    expect(registered).toHaveLength(1);
    expect(store.data.get("fakelinear")?.tokens?.access_token).toBeTruthy();
    expect(store.data.get("fakelinear")?.codeVerifier).toBeUndefined();

    const id = mcpAgentToolId("fakelinear", "list_issues");
    expect(id).toBe("fakelinear__list_issues");
    const tool = registry.get(id)!;
    expect(tool.description).toContain("read-only");
    const out = (await tool.execute({ team: "ENG" })) as { success: boolean; data: string };
    expect(out.success).toBe(true);
    expect(out.data).toContain("ENG-1");
  });

  it("restores from stored tokens without a browser", async () => {
    const svc2 = new McpConnectionService({
      store,
      openBrowser: () => {
        throw new Error("must not open browser");
      },
      customServersFile: (svc as unknown as { customFile: string }).customFile,
    });
    const def = await svc2.getServer("fakelinear");
    def!.url = `${base}/mcp`;
    const s = await svc2.ensure("fakelinear");
    expect(s.state).toBe("connected");
    const res = await svc2.callTool("fakelinear", "list_issues", { team: "OPS" });
    expect(res.content?.[0]?.text).toContain("OPS");
    await svc2.shutdown();
  });

  it("marks needs_reauth (no browser) when stored tokens are rejected", async () => {
    const saved = store.data.get("fakelinear")!;
    store.data.set("fakelinear", { ...saved, tokens: { access_token: "dead", token_type: "bearer" } });
    const svc3 = new McpConnectionService({
      store,
      openBrowser: () => {
        throw new Error("must not open browser");
      },
      customServersFile: (svc as unknown as { customFile: string }).customFile,
    });
    (await svc3.getServer("fakelinear"))!.url = `${base}/mcp`;
    const s = await svc3.ensure("fakelinear");
    expect(s.state).toBe("needs_reauth");
    store.data.set("fakelinear", saved);
  });

  it("enforces Pen access on real tool calls (read / ask / full, org cap)", async () => {
    const { createPenGate } = await import("./mcpPenGate.js");
    let level: string | undefined = "read";
    let orgMax: string | undefined;
    const asked: string[] = [];
    let answer = true;
    const gated = new McpConnectionService({
      store,
      openBrowser: () => {
        throw new Error("must not open browser");
      },
      customServersFile: (svc as unknown as { customFile: string }).customFile,
      penGate: createPenGate({
        keyLevel: async () => level,
        orgMax: async () => orgMax,
        serverName: () => "Fake Linear",
        ask: async (_id, _n, tool) => (asked.push(tool), answer),
      }),
    });
    (await gated.getServer("fakelinear"))!.url = `${base}/mcp`;
    expect((await gated.ensure("fakelinear")).state).toBe("connected");

    // Read only: reads run, anything unflagged is refused without asking.
    expect((await gated.callTool("fakelinear", "list_issues", { team: "A" })).content?.[0]?.text).toContain("A");
    await expect(gated.callTool("fakelinear", "create_issue", { title: "x" })).rejects.toThrow(/Read only/);
    expect(asked).toEqual([]);

    // Ask: changes ask first; declining blocks, allowing runs.
    level = "ask";
    answer = false;
    await expect(gated.callTool("fakelinear", "create_issue", { title: "x" })).rejects.toThrow(/declined/);
    answer = true;
    expect((await gated.callTool("fakelinear", "create_issue", { title: "y" })).content?.[0]?.text).toBe("created y");
    expect(asked).toEqual(["create_issue", "create_issue"]);

    // Full: changes run without asking; destructive still asks.
    level = "full";
    asked.length = 0;
    await gated.callTool("fakelinear", "create_issue", { title: "z" });
    await gated.callTool("fakelinear", "delete_issue", { id: "1" });
    expect(asked).toEqual(["delete_issue"]);

    // Org cap: key says full, org max is read → refused.
    orgMax = "read";
    await expect(gated.callTool("fakelinear", "create_issue", { title: "q" })).rejects.toThrow(/Read only/);

    // Older sign-in with no level behaves as "ask".
    level = undefined;
    orgMax = undefined;
    asked.length = 0;
    await gated.callTool("fakelinear", "create_issue", { title: "r" });
    expect(asked).toEqual(["create_issue"]);
    await gated.shutdown();
  });

  it("disconnect removes credentials and tools", async () => {
    await svc.disconnect("fakelinear");
    expect(store.data.has("fakelinear")).toBe(false);
    expect([...registry.keys()].some((k) => k.startsWith("fakelinear__"))).toBe(false);
    expect(tokenIssues).toBeGreaterThan(0);
  });
});
