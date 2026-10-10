/**
 * OAuth for the MCP endpoint.
 *
 * - Protected-resource metadata (RFC 9728) tells Claude to sign in with Auth0.
 * - Bearer verification: Auth0 access token (RS256, JWKS), audience = this resource.
 * - Identity: the same Papr Auth0 Action that puts the Parse session on the web ID token
 *   must also put it on access tokens for the MCP audience. The api tunnel forwards that
 *   session to the existing /api handlers, so access rules are identical to apps.papr.ai.
 *
 * PR 3: when PAPR_MCP_SERVICE_KEY is set, the verifier hands the token to memory
 * (session.ts), which maps it to the Papr user, provisions first-run accounts and mints an
 * MCP-only session. The claims bridge below stays only as a fallback for local spikes.
 */
import type { Express, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { protectedResourceMetadataUrl, type McpEndpointConfig } from "./config.js";
import type { McpSessionExchange } from "./session.js";

export const CLAIM_SESSION = "https://papr.scope.com/sessionToken";
export const CLAIM_OBJECT_ID = "https://papr.scope.com/objectId";
export const CLAIM_EMAIL = "https://papr.scope.com/email";

/** The Papr caller behind an MCP request. Never sent to Claude. */
export interface McpCaller {
  sessionToken: string;
  userId: string;
  email?: string;
  displayName?: string;
  subject: string;
  /** Tenant from memory's session exchange (absent on the claims bridge). */
  organizationId?: string;
  namespaceId?: string;
  workspaceId?: string;
  /** What first sign-in created ("workspace", "organization", "namespace"), if anything. */
  provisioned?: string[];
}

export function callerFromClaims(claims: JWTPayload): McpCaller {
  const sessionToken = claims[CLAIM_SESSION];
  const userId = claims[CLAIM_OBJECT_ID];
  if (typeof sessionToken !== "string" || !sessionToken || typeof userId !== "string" || !userId) {
    // Signed in to Auth0, but Papr account provisioning hasn't attached a session yet.
    throw new InvalidTokenError("Papr account setup isn't finished. Reconnect Papr in Claude.");
  }
  const email = claims[CLAIM_EMAIL] ?? claims.email;
  return {
    sessionToken,
    userId,
    email: typeof email === "string" ? email : undefined,
    subject: String(claims.sub ?? ""),
  };
}

/**
 * Verifies the Auth0 token locally (cheap reject of garbage before touching memory), then
 * resolves the Papr caller: memory exchange when configured, else the claims bridge.
 */
export function createAuth0Verifier(cfg: McpEndpointConfig, exchange?: McpSessionExchange): OAuthTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(`${cfg.issuer}.well-known/jwks.json`));
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: cfg.issuer,
          audience: cfg.audience,
          algorithms: ["RS256"],
        }));
      } catch {
        throw new InvalidTokenError("Invalid or expired Papr token");
      }
      const subject = String(payload.sub ?? "");
      const caller = exchange ? { ...(await exchange(token, payload.exp)), subject } : callerFromClaims(payload);
      const scope = typeof payload.scope === "string" ? payload.scope : "";
      return {
        token,
        clientId: String(payload.azp ?? payload.client_id ?? ""),
        scopes: scope.split(" ").filter(Boolean),
        expiresAt: payload.exp,
        resource: new URL(cfg.resourceUrl),
        extra: { caller },
      };
    },
  };
}

export function protectedResourceMetadata(cfg: McpEndpointConfig): Record<string, unknown> {
  return {
    resource: cfg.resourceUrl,
    authorization_servers: [cfg.issuer],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "Papr",
    resource_documentation: "https://platform.papr.ai",
  };
}

/** Serves RFC 9728 metadata at both the path-suffixed and root well-known URLs. */
export function registerProtectedResourceMetadata(app: Express, cfg: McpEndpointConfig): void {
  const body = protectedResourceMetadata(cfg);
  const send = (_req: Request, res: Response): void => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(body);
  };
  const suffixed = new URL(protectedResourceMetadataUrl(cfg)).pathname;
  app.get(suffixed, send);
  // Per-app connector URLs (/mcp/a/{ns}/{slug}) share the resource: it is a path prefix of
  // theirs (RFC 8707 / MCP SDK checkResourceAllowed), so one Auth0 audience covers every app.
  app.get(`${suffixed}/a/:namespaceId/:slug`, send);
  app.get("/.well-known/oauth-protected-resource", send);
}

export function callerOf(authInfo: AuthInfo | undefined): McpCaller {
  const caller = authInfo?.extra?.caller as McpCaller | undefined;
  if (!caller) throw new InvalidTokenError("Missing Papr caller");
  return caller;
}
