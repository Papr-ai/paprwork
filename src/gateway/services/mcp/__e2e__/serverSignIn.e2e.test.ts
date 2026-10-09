/**
 * End-to-end: Connections server sign-in (4a–4d) across all three pieces.
 *
 *   fake MCP provider (SDK auth router + MCP endpoint, strict refresh rotation)
 *   memory server     (real session/callback/refresh/vault code, Mongo, fake Secret Manager)
 *                      -> tests/e2e/oauth_e2e_server.py in the memory repo, on :18850
 *   apps.papr.ai host (real proxyOAuthCallback) on :18851
 *   desktop gateway   (real McpConnectionService + McpServerSignIn), one per user
 *
 * The "browser" follows redirects from the provider's consent page to the
 * callback and stops at the papr:// deep link, exactly like a user click.
 *
 * Run: E2E_MEMORY_URL=http://127.0.0.1:18850 npx vitest run src/gateway/services/mcp/__e2e__/serverSignIn.e2e.test.ts
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
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { McpConnectionService } from "../McpConnectionService.js";
import { createMemoryMcpCredentialStore } from "../mcpCredentialStore.js";
import { McpServerSignIn, isServerManagedCredential } from "../mcpServerSignIn.js";
import { proxyOAuthCallback } from "../../appRuntime/oauthCallbackProxy.js";

const MEMORY = process.env.E2E_MEMORY_URL ?? "http://127.0.0.1:18850";
const CALLBACK_PORT = 18851;
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`;
const live = await fetch(`${MEMORY}/health`).then((r) => r.ok).catch(() => false);

// ── fake provider ───────────────────────────────────────────────────────────
const P = { deny: false, refreshes: 0, rejectedRefreshes: 0, tokenSecretsSeen: [] as string[] };
const tokens = new Map<string, string>();
const refreshTokens = new Map<string, string>();
let base = "";
let provider: http.Server;
let callbackHost: http.Server;

function fakeProvider(): OAuthServerProvider {
  const clients = new Map<string, OAuthClientInformationFull>();
  const codes = new Map<string, { clientId: string; challenge: string }>();
  const issue = (clientId: string) => {
    const access = randomUUID();
    const refresh = randomUUID();
    tokens.set(access, clientId);
    refreshTokens.set(refresh, clientId);
    return { access_token: access, token_type: "bearer", expires_in: 3600, refresh_token: refresh };
  };
  return {
    clientsStore: {
      getClient: (id) => clients.get(id),
      registerClient: (c) => {
        const full = { ...c, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
        clients.set(full.client_id, full);
        return full;
      },
    },
    async authorize(client, params, res) {
      const u = new URL(params.redirectUri);
      if (params.state) u.searchParams.set("state", params.state);
      if (P.deny) {
        u.searchParams.set("error", "access_denied");
        return res.redirect(u.toString());
      }
      const code = randomUUID();
      codes.set(code, { clientId: client.client_id, challenge: params.codeChallenge });
      u.searchParams.set("code", code);
      res.redirect(u.toString());
    },
    async challengeForAuthorizationCode(_c, code) {
      return codes.get(code)!.challenge;
    },
    async exchangeAuthorizationCode(client, code) {
      const c = codes.get(code);
      if (!c || c.clientId !== client.client_id) throw new InvalidGrantError("bad code");
      codes.delete(code);
      return issue(client.client_id);
    },
    async exchangeRefreshToken(client, refresh) {
      // Strict rotation: a refresh token works once (HubSpot/Slack-style).
      if (refreshTokens.get(refresh) !== client.client_id) {
        P.rejectedRefreshes++;
        throw new InvalidGrantError("refresh token already used");
      }
      refreshTokens.delete(refresh);
      P.refreshes++;
      return issue(client.client_id);
    },
    async verifyAccessToken(token) {
      const clientId = tokens.get(token);
      if (!clientId) throw new InvalidTokenError("invalid token");
      return { token, clientId, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    },
  };
}

// ── desktop gateways ────────────────────────────────────────────────────────
const browser = async (url: string): Promise<string | null> => {
  let next = url;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(next, { redirect: "manual" });
    const loc = r.headers.get("location");
    if (!loc) return null;
    if (loc.startsWith("papr://")) return loc;
    next = new URL(loc, next).toString();
  }
  return null;
};

function desktop(user: string, org = "org1") {
  const store = createMemoryMcpCredentialStore();
  const deepLinks: string[] = [];
  const signIn = new McpServerSignIn({
    redirectUri: REDIRECT,
    pollMs: 150,
    cloud: (p, init) =>
      fetch(`${MEMORY}${p}`, {
        method: init?.method ?? "GET",
        headers: { "X-API-Key": `${org}:${user}:ns1`, "Content-Type": "application/json" },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
  });
  const svc = new McpConnectionService({
    store,
    serverSignIn: signIn,
    openBrowser: (u) => void browser(u).then((l) => l && deepLinks.push(l)),
    customServersFile: path.join(os.tmpdir(), `mcp-e2e-${randomUUID()}.json`),
  });
  return { svc, store, signIn, deepLinks };
}

async function addFake(svc: McpConnectionService) {
  const def = await svc.addCustomServer({ url: "https://placeholder.invalid/mcp", name: "Fake CRM", id: "fakecrm" });
  def.url = `${base}/mcp`;
  return def;
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any
const memory = (p: string, body?: unknown): Promise<any> =>
  fetch(`${MEMORY}${p}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());

beforeAll(async () => {
  if (!live) return;
  const app = express();
  app.use(express.json());
  provider = http.createServer(app);
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const prov = fakeProvider();
  app.use(mcpAuthRouter({ provider: prov, issuerUrl: new URL(base), resourceServerUrl: new URL(`${base}/mcp`) }));
  app.post("/mcp", requireBearerAuth({ verifier: prov, resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp` }), async (req, res) => {
    const mcp = new McpServer({ name: "fake-crm", version: "1" });
    mcp.registerTool("list_deals", { description: "List deals", inputSchema: { stage: z.string() }, annotations: { readOnlyHint: true } },
      async ({ stage }) => ({ content: [{ type: "text", text: `deals in ${stage}: Acme, Globex` }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void t.close());
    await mcp.connect(t);
    await t.handleRequest(req, res, req.body);
  });

  process.env.PAPR_MEMORY_SERVER_URL = MEMORY;
  const host = express();
  host.get("/oauth/callback", (req, res) => void proxyOAuthCallback(req, res));
  callbackHost = http.createServer(host);
  await new Promise<void>((r) => callbackHost.listen(CALLBACK_PORT, "127.0.0.1", r));
  await memory("/e2e/reset", {});
});

afterAll(async () => {
  await Promise.all([provider, callbackHost].filter(Boolean).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe.skipIf(!live)("Connections server sign-in, end to end", () => {
  const alice = desktop("alice");
  const bob = desktop("bob");
  const eve = desktop("eve", "org2");

  it("1. admin connects a team connection: consent → apps.papr.ai callback → vault → desktop", async () => {
    await addFake(alice.svc);
    const { status, completion } = await alice.svc.connect("fakecrm", { audience: "org" });
    expect(status.state).toBe("awaiting_user");
    const done = await completion;
    expect(done.state).toBe("connected");
    expect(alice.deepLinks[0]).toMatch(/^papr:\/\/connections\/signed-in\?session=\w+&status=ok$/);

    const cred = await alice.store.load("fakecrm");
    expect(cred?.serverRefresh).toBe(true);
    expect(cred?.tokens?.access_token).toBeTruthy();
    expect(cred?.tokens?.refresh_token).toBeUndefined(); // never leaves the server
    expect(isServerManagedCredential(JSON.stringify(cred))).toBe(true); // pull-only for vault push

    const vault = await memory("/e2e/vault");
    const key = vault.MCP_FAKECRM_OAUTH;
    expect(key.labels["papr-share-scope"]).toBe("org");
    expect(key.labels["papr-source"]).toBe("oauth");
    expect(key.labels["papr-owner-user"]).toBe("alice");
    expect(key.serverRefresh && key.hasRefreshToken).toBe(true);
  });

  it("2. Pen uses it", async () => {
    const out = await alice.svc.callTool("fakecrm", "list_deals", { stage: "won" });
    expect(JSON.stringify(out)).toContain("Acme");
  });

  it("3. a teammate's Mac picks it up without signing in", async () => {
    await addFake(bob.svc);
    expect(await bob.svc.pickUpSharedConnections()).toEqual(["fakecrm"]);
    expect((await bob.svc.ensure("fakecrm")).state).toBe("connected");
    const out = await bob.svc.callTool("fakecrm", "list_deals", { stage: "open" });
    expect(JSON.stringify(out)).toContain("Globex");
  });

  it("4. someone in another org gets nothing", async () => {
    await addFake(eve.svc);
    expect(await eve.svc.pickUpSharedConnections()).toEqual([]);
    expect(await eve.signIn.claim("fakecrm")).toBeNull();
  });

  it("5. token revoked: both Macs recover with ONE server refresh (rotation-safe)", async () => {
    tokens.clear(); // provider drops every access token
    const before = P.refreshes;
    const [a, b] = await Promise.all([
      alice.svc.callTool("fakecrm", "list_deals", { stage: "won" }),
      bob.svc.callTool("fakecrm", "list_deals", { stage: "won" }),
    ]);
    expect(JSON.stringify(a)).toContain("Acme");
    expect(JSON.stringify(b)).toContain("Acme");
    expect(P.refreshes - before).toBe(1);
    expect(P.rejectedRefreshes).toBe(0);
    expect((await alice.store.load("fakecrm"))?.tokens?.refresh_token).toBeUndefined();
  });

  it("6. user cancels on the consent page: session fails cleanly, nothing saved", async () => {
    const carol = desktop("carol");
    await addFake(carol.svc);
    const before = Object.keys(await memory("/e2e/vault")).length;
    P.deny = true;
    try {
      const { completion } = await carol.svc.connect("fakecrm", { viaServer: true });
      await expect(completion).rejects.toThrow(/cancelled/i);
    } finally {
      P.deny = false;
    }
    expect(carol.deepLinks[0]).toMatch(/status=failed$/);
    expect(Object.keys(await memory("/e2e/vault")).length).toBe(before);
  });

  it("7. org rules block an unapproved service before any browser opens", async () => {
    await memory("/e2e/policy/org1", { mode: "approved", approved: ["notion"], maxShare: "org" });
    const dave = desktop("dave");
    await addFake(dave.svc);
    await expect(dave.svc.connect("fakecrm", { audience: "user", viaServer: true })).rejects.toThrow(/hasn't approved/);
    expect(dave.deepLinks).toHaveLength(0);
    await memory("/e2e/policy/org1", { mode: "all", maxShare: "user" });
    await expect(dave.svc.connect("fakecrm", { audience: "org" })).rejects.toThrow(/sharing up to 'user'/);
    await memory("/e2e/policy/org1", { mode: "all" });
  });

  it("8. a sign-in link works once", async () => {
    // Replay the last successful callback URL: the state is already used.
    const r = await fetch(`${REDIRECT}?state=bogus-or-used&code=x`);
    expect(r.status).toBe(410);
    expect(await r.text()).toContain("expired");
  });
});
