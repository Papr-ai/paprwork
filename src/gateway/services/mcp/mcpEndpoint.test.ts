/**
 * PR 0 spike: the MCP endpoint end to end against a real Express app.
 *
 * The fake /api handlers live on the same app the tunnel loops back into, so these
 * tests exercise the real path: bearer auth → McpServer → papr_api → loopback HTTP →
 * /api handler, with the caller's headers asserted on the way in.
 */
import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { assertTunnelAllowed, dispatchTunnel, type TunnelRequest } from "./apiTunnel.js";
import { callerFromClaims, CLAIM_OBJECT_ID, CLAIM_SESSION } from "./auth.js";
import type { McpEndpointConfig } from "./config.js";
import { appCardUri, parseAppRef, registerMcpRoutes, SPIKE_CARD_URI } from "./server.js";
import { inlineExtAppsBundle } from "./spikeCard.js";

const GOOD = "good-token";
const caller = { sessionToken: "r:parse-session", userId: "user123", email: "a@papr.ai", subject: "google|1" };

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    if (token !== GOOD) throw new InvalidTokenError("bad token");
    return { token, clientId: "claude", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600, extra: { caller } };
  },
};

let server: Server;
let base: string;
const seen: Array<Record<string, string | undefined>> = [];

function fakeApi(app: Express): void {
  const record = (req: express.Request): void => {
    seen.push({
      path: req.path,
      session: req.header("x-session-token"),
      user: req.header("x-papr-external-user-id"),
      ns: req.header("x-papr-namespace-id"),
      slug: req.header("x-papr-slug"),
    });
  };
  app.get("/api/access", (req, res) => {
    record(req);
    res.json({ canRead: req.header("x-papr-slug") !== "private-app", canWrite: false, loggedIn: true });
  });
  app.get("/ns1/linkedin-outreach/dist/cards/:file", (req, res) => {
    record(req);
    if (req.params.file !== "status.html") return void res.status(404).send("Not found");
    res.type("html").send("<!doctype html><title>status card</title>");
  });
  app.post("/api/db/query", (req, res) => {
    record(req);
    res.json({ rows: [{ name: "campaigns" }, { name: "replies" }], columns: ["name"], count: 2, sql: req.body.sql });
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  const config: McpEndpointConfig = {
    resourceUrl: `${base}/mcp`,
    issuer: "https://papr.auth0.com/",
    audience: `${base}/mcp`,
    appsBaseUrl: "https://apps.papr.ai",
    loopbackPort: port,
  };
  registerMcpRoutes(app, { port, verifier, config });
  fakeApi(app);
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function connect(): Promise<Client> {
  const client = new Client({ name: "test-claude", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${GOOD}` } },
  });
  await client.connect(transport);
  return client;
}

describe("MCP endpoint auth", () => {
  it("advertises Auth0 via RFC 9728 protected-resource metadata", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(`${base}/mcp`);
    expect(body.authorization_servers).toEqual(["https://papr.auth0.com/"]);
  });

  it("answers 401 with resource_metadata so Claude shows Connect", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("rejects tokens without the Papr session claims", () => {
    expect(() => callerFromClaims({ sub: "x" })).toThrow(/setup isn't finished/);
    expect(callerFromClaims({ sub: "x", [CLAIM_SESSION]: "r:s", [CLAIM_OBJECT_ID]: "u1" }).userId).toBe("u1");
  });
});

describe("MCP endpoint tools and card", () => {
  it("lists the open tool with its card and hides papr_api from the model", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const open = tools.find((t) => t.name === "papr_open_app");
    const api = tools.find((t) => t.name === "papr_api");
    expect((open?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri).toBe(SPIKE_CARD_URI);
    expect((api?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility).toEqual(["app"]);
    await client.close();
  });

  it("serves the card as a single self-contained MCP App HTML", async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: SPIKE_CARD_URI });
    const html = String((contents[0] as { text?: string }).text);
    expect(contents[0].mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(html).toContain("globalThis.McpApps=");
    expect(html).not.toMatch(/<script[^>]+src=/);
    await client.close();
  });

  it("opens an app the caller can read, and refuses one they can't", async () => {
    const client = await connect();
    const ok = await client.callTool({ name: "papr_open_app", arguments: { url: "https://apps.papr.ai/ns1/linkedin-outreach" } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ namespaceId: "ns1", slug: "linkedin-outreach", openUrl: "https://apps.papr.ai/ns1/linkedin-outreach" });
    const denied = await client.callTool({ name: "papr_open_app", arguments: { namespaceId: "ns1", slug: "private-app" } });
    expect(denied.isError).toBe(true);
    await client.close();
  });

  it("tunnels a card's /api/db/query as the signed-in user", async () => {
    seen.length = 0;
    const client = await connect();
    const out = await client.callTool({
      name: "papr_api",
      arguments: { namespaceId: "ns1", slug: "linkedin-outreach", method: "POST", path: "/api/db/query", body: { sql: "SELECT 1" } },
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ status: 200, body: { count: 2 } });
    expect(seen).toEqual([{ path: "/api/db/query", session: "r:parse-session", user: "user123", ns: "ns1", slug: "linkedin-outreach" }]);
    await client.close();
  });

  it("refuses paths outside the card allowlist", async () => {
    const client = await connect();
    const out = await client.callTool({
      name: "papr_api",
      arguments: { namespaceId: "ns1", slug: "a", method: "POST", path: "/api/bash/run", body: {} },
    });
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toMatchObject({ status: 403 });
    await client.close();
  });
});

describe("published app cards", () => {
  it("serves dist/cards/{view}.html as an MCP App resource, read as the caller", async () => {
    seen.length = 0;
    const client = await connect();
    const uri = appCardUri("ns1", "linkedin-outreach", "status");
    const { contents } = await client.readResource({ uri });
    expect(contents[0]).toMatchObject({ uri, mimeType: RESOURCE_MIME_TYPE });
    expect(String((contents[0] as { text?: string }).text)).toContain("status card");
    expect(seen[0]).toMatchObject({ path: "/ns1/linkedin-outreach/dist/cards/status.html", session: "r:parse-session", user: "user123" });
    await client.close();
  });

  it("errors clearly for a view that wasn't published, and rejects bad refs", async () => {
    const client = await connect();
    await expect(client.readResource({ uri: appCardUri("ns1", "linkedin-outreach", "inbox") })).rejects.toThrow(/isn't published/);
    await expect(client.readResource({ uri: appCardUri("ns1", "linkedin-outreach", "..") })).rejects.toThrow();
    await client.close();
  });
});

describe("api tunnel guards", () => {
  const r = (p: Partial<TunnelRequest>): TunnelRequest => ({ namespaceId: "ns1", slug: "app", method: "POST", path: "/api/db/query", ...p });
  it.each([
    ["traversal", { path: "/api/db/../bash/run" }],
    ["credentials", { path: "/api/credentials/client-keys" }],
    ["wrong method", { method: "GET" as const, path: "/api/db/write" }],
    ["bad slug", { slug: "../x" }],
    ["GET with body", { method: "GET" as const, path: "/api/access", body: {} }],
  ])("blocks %s", (_n, p) => expect(() => assertTunnelAllowed(r(p))).toThrow());

  it("allows backend actions and job status", () => {
    expect(() => assertTunnelAllowed(r({ path: "/api/app/backend/create-campaign" }))).not.toThrow();
    expect(() => assertTunnelAllowed(r({ method: "GET", path: "/api/jobs/status/job_1" }))).not.toThrow();
  });

  it("never forwards a body to fetch for a blocked call", async () => {
    let called = false;
    const fake = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    await expect(dispatchTunnel(1, caller, r({ path: "/api/bash/run" }), fake)).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe("helpers", () => {
  it("parses apps.papr.ai links", () => {
    expect(parseAppRef({ url: "https://apps.papr.ai/85ZIB7mD1V/new-shelf/index.html" })).toEqual({ namespaceId: "85ZIB7mD1V", slug: "new-shelf" });
    expect(() => parseAppRef({})).toThrow();
  });

  it("turns the ext-apps ESM export list into a global", () => {
    const out = inlineExtAppsBundle("var a=1,b=2;export{a as App,b as X,c};");
    expect(out).toContain('globalThis.McpApps={"App":a,"X":b,"c":c};');
    expect(out).not.toContain("export{");
  });
});
