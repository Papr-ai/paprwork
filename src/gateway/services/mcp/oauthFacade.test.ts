import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpEndpointConfig } from "./config.js";
import { registerProtectedResourceMetadata } from "./auth.js";
import { facadeIssuer, registerOAuthFacade, type OAuthFacadeConfig } from "./oauthFacade.js";

let server: Server;
let base = "";
const upstream: Array<{ url: string; body: string }> = [];
const facade: OAuthFacadeConfig = { clientId: "shared-client", clientSecret: "s3cret", redirectUris: ["https://claude.ai/api/mcp/auth_callback"] };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cfg: McpEndpointConfig = { resourceUrl: `${base}/mcp`, issuer: "https://papr.auth0.com/", audience: `${base}/mcp`, appsBaseUrl: "https://apps.papr.ai", loopbackPort: 0 };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    upstream.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ access_token: "at", token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  registerOAuthFacade(app, cfg, facade, fakeFetch);
  registerProtectedResourceMetadata(app, cfg, facadeIssuer(cfg));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("OAuth facade (one shared Auth0 client)", () => {
  it("points Claude at this server, which sends sign-in to Auth0", async () => {
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as { authorization_servers: string[] };
    expect(prm.authorization_servers).toEqual([base]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
    expect(as.issuer).toBe(base);
    expect(as.authorization_endpoint).toBe("https://papr.auth0.com/authorize");
    expect(as.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(as.token_endpoint).toBe(`${base}/oauth/token`);
  });

  it("registration always returns the shared client, as a public client", async () => {
    const reg = async () =>
      (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) })).json() as Promise<Record<string, unknown>>;
    const [a, b] = [await reg(), await reg()];
    expect(a.client_id).toBe("shared-client");
    expect(b.client_id).toBe("shared-client");
    expect(a.token_endpoint_auth_method).toBe("none");
    expect(a).not.toHaveProperty("client_secret");
  });

  it("rejects registration for redirect URIs the shared client doesn't allow", async () => {
    const res = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) });
    expect(res.status).toBe(400);
  });

  it("token proxy adds the secret server-side and forwards PKCE", async () => {
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "c1", code_verifier: "v1", redirect_uri: "https://claude.ai/api/mcp/auth_callback", client_id: "shared-client", client_secret: "attacker" }).toString(),
    });
    expect(res.status).toBe(200);
    const sent = new URLSearchParams(upstream.at(-1)!.body);
    expect(upstream.at(-1)!.url).toBe("https://papr.auth0.com/oauth/token");
    expect(sent.get("client_secret")).toBe("s3cret");
    expect(sent.get("code_verifier")).toBe("v1");
  });

  it("token proxy rejects other clients and grants", async () => {
    const post = (b: Record<string, string>) => fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(b).toString() });
    expect((await post({ grant_type: "authorization_code", client_id: "other" })).status).toBe(401);
    expect((await post({ grant_type: "client_credentials", client_id: "shared-client" })).status).toBe(400);
  });
});
