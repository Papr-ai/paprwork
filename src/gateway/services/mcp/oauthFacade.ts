/**
 * OAuth facade: lets Claude connect by URL alone without Auth0 creating a client per user.
 *
 * Claude's "Register automatically" (RFC 7591 dynamic client registration) would create one
 * Auth0 application per connecting user. Auth0 caps applications per tenant, so that fails at
 * scale (and already fails: the tenant is at its cap). Instead this server is the
 * authorization server Claude discovers, and:
 *   - /oauth/register always answers with the ONE shared Auth0 client ("Claude (MCP connector)").
 *     Nothing is created. Claude is told it is a public client (no secret).
 *   - authorization goes straight to Auth0's /authorize (Auth0 shows the Papr sign-in and
 *     enforces the client's callback allow-list).
 *   - /oauth/token proxies to Auth0's /oauth/token and adds the client secret server-side, so
 *     the secret never reaches Claude. PKCE still binds every code to the client that asked.
 * Access tokens are still Auth0 tokens for the MCP audience, verified exactly as before.
 *
 * Off unless PAPR_MCP_OAUTH_CLIENT_ID is set; then the protected-resource metadata points at
 * this server instead of Auth0.
 */
import type { Express, Request, Response } from "express";
import type { McpEndpointConfig } from "./config.js";

export interface OAuthFacadeConfig {
  clientId: string;
  clientSecret?: string;
  /** Redirect URIs the shared client allows (mirrors its Auth0 callbacks). */
  redirectUris: string[];
}

const DEFAULT_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
const SCOPES = ["openid", "profile", "email", "offline_access"];

export function loadOAuthFacadeConfig(): OAuthFacadeConfig | undefined {
  const clientId = process.env.PAPR_MCP_OAUTH_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  const extra = (process.env.PAPR_MCP_OAUTH_REDIRECT_URIS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { clientId, clientSecret: process.env.PAPR_MCP_OAUTH_CLIENT_SECRET?.trim() || undefined, redirectUris: [...DEFAULT_REDIRECTS, ...extra] };
}

/** Issuer of the facade: the MCP resource's origin (no path, so RFC 8414 well-known is at the root). */
export function facadeIssuer(cfg: McpEndpointConfig): string {
  return new URL(cfg.resourceUrl).origin;
}

export function authorizationServerMetadata(cfg: McpEndpointConfig): Record<string, unknown> {
  const issuer = facadeIssuer(cfg);
  return {
    issuer,
    authorization_endpoint: `${cfg.issuer}authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    jwks_uri: `${cfg.issuer}.well-known/jwks.json`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

export function registerOAuthFacade(app: Express, cfg: McpEndpointConfig, facade: OAuthFacadeConfig, fetchImpl: typeof fetch = fetch): void {
  const meta = authorizationServerMetadata(cfg);
  const sendMeta = (_req: Request, res: Response): void => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(meta);
  };
  app.get("/.well-known/oauth-authorization-server", sendMeta);
  app.get("/.well-known/openid-configuration", sendMeta);

  // RFC 7591: hand back the shared client. Never creates anything.
  app.post("/oauth/register", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const asked = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!asked.length) return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris is required");
    const bad = asked.filter((u) => !facade.redirectUris.includes(u));
    if (bad.length) return oauthError(res, 400, "invalid_redirect_uri", `Redirect URI not allowed: ${bad.join(", ")}`);
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      client_id: facade.clientId,
      client_id_issued_at: 0,
      client_name: typeof body.client_name === "string" ? body.client_name : "Claude",
      redirect_uris: asked,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // Token proxy: same request to Auth0, with the shared client's secret added server-side.
  app.post("/oauth/token", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grant = String(body.grant_type ?? "");
    if (grant !== "authorization_code" && grant !== "refresh_token") {
      return oauthError(res, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported");
    }
    if (body.client_id && String(body.client_id) !== facade.clientId) {
      return oauthError(res, 401, "invalid_client", "Unknown client");
    }
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (k === "client_secret" || v === undefined || v === null || typeof v === "object") continue;
      form.set(k, String(v));
    }
    form.set("client_id", facade.clientId);
    if (facade.clientSecret) form.set("client_secret", facade.clientSecret);
    try {
      const upstream = await fetchImpl(`${cfg.issuer}oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
      res.send(text);
    } catch {
      oauthError(res, 502, "temporarily_unavailable", "Papr sign-in is unreachable. Try again.");
    }
  });
}
