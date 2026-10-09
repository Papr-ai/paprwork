/**
 * Server sign-in for Connections (desktop side of 4a–4c).
 *
 * Used for team connections and services that need the org's client ID/secret.
 * The memory server owns state + PKCE, does the code exchange at
 * apps.papr.ai/oauth/callback, keeps the refresh token, and hands this Mac
 * fresh access tokens through /refresh/claim. The desktop never refreshes these
 * itself and never pushes them back to the vault (see isServerManagedCredential).
 *
 * Personal sign-ins for services with dynamic registration still use the
 * loopback flow in McpConnectionService.
 */

import { createHash } from "node:crypto";
import { discoverOAuthServerInfo, registerClient } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerDefinition } from "./mcpServerCatalog.js";
import type { McpStoredCredential } from "./McpOAuthProvider.js";

export type CloudFetch = (path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;
export type ConnectionAudience = "user" | "members" | "namespace" | "org";

export const DEFAULT_SERVER_REDIRECT = "https://apps.papr.ai/oauth/callback";

export interface ServerSignInDeps {
  cloud: CloudFetch;
  /** Where providers send the user back (apps.papr.ai/oauth/callback in production). */
  redirectUri?: string;
  /** Org client ID saved by an admin (vault key MCP_<ID>_CLIENT_ID), if any. */
  orgClientId?: (serverId: string) => Promise<string | undefined | null>;
  pollMs?: number;
  timeoutMs?: number;
}

export class ServerSignInError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ServerSignInError";
  }
}

/** Server-refreshed credentials stay pull-only on this Mac. */
export function isServerManagedCredential(raw: string | null | undefined): boolean {
  if (!raw || !raw.includes("serverRefresh")) return false;
  try {
    return (JSON.parse(raw) as McpStoredCredential).serverRefresh === true;
  } catch {
    return false;
  }
}

export function orgClientIdKeyName(serverId: string): string {
  return `MCP_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_ID`;
}

async function body<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const detail = data.detail ?? data.error ?? `HTTP ${res.status}`;
    throw new ServerSignInError(typeof detail === "string" ? detail : JSON.stringify(detail), res.status);
  }
  return data as T;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new ServerSignInError("Sign-in cancelled", 499))), { once: true });
  });

export class McpServerSignIn {
  private readonly dcrClients = new Map<string, string>();

  constructor(private readonly deps: ServerSignInDeps) {}

  get redirectUri(): string {
    return this.deps.redirectUri ?? DEFAULT_SERVER_REDIRECT;
  }

  async hasClientId(def: McpServerDefinition): Promise<boolean> {
    if (def.clientId) return true;
    return Boolean(await this.deps.orgClientId?.(def.id).catch(() => null));
  }

  private async clientIdFor(def: McpServerDefinition, md: AuthorizationServerMetadata, authServer: string): Promise<string> {
    if (def.clientId) return def.clientId;
    const org = await this.deps.orgClientId?.(def.id).catch(() => null);
    if (org) return org;
    const cached = this.dcrClients.get(def.id);
    if (cached) return cached;
    if (!md.registration_endpoint) {
      throw new ServerSignInError(`${def.name} needs a one-time setup by your admin before anyone can connect.`, 412);
    }
    const info = await registerClient(authServer, {
      metadata: md,
      clientMetadata: {
        client_name: "Papr Work",
        client_uri: "https://papr.ai",
        redirect_uris: [this.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    this.dcrClients.set(def.id, info.client_id);
    return info.client_id;
  }

  /** Create the server session and return the URL to open. */
  async start(
    def: McpServerDefinition,
    opts: { audience: ConnectionAudience; allowedUserIds?: string[]; origin?: string },
  ): Promise<{ sessionId: string; authorizeUrl: string }> {
    const info = await discoverOAuthServerInfo(def.url);
    const md = info.authorizationServerMetadata;
    if (!md?.authorization_endpoint || !md.token_endpoint) {
      throw new ServerSignInError(`${def.name} didn't publish its sign-in endpoints.`, 502);
    }
    const clientId = await this.clientIdFor(def, md, info.authorizationServerUrl);
    const res = await this.deps.cloud("/v1/cloud/oauth/sessions", {
      method: "POST",
      body: {
        serverId: def.id,
        origin: opts.origin ?? "desktop",
        audience: opts.audience,
        authorizationEndpoint: md.authorization_endpoint,
        tokenEndpoint: md.token_endpoint,
        clientId,
        scopes: info.resourceMetadata?.scopes_supported ?? undefined,
        resource: info.resourceMetadata?.resource ?? def.url,
        ...(opts.allowedUserIds?.length ? { allowedUserIds: opts.allowedUserIds } : {}),
      },
    });
    const out = await body<{ id: string; authorizeUrl: string }>(res);
    return { sessionId: out.id, authorizeUrl: out.authorizeUrl };
  }

  /** Poll until the callback finished (or failed / expired). */
  async wait(sessionId: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.deps.timeoutMs ?? 11 * 60_000);
    while (Date.now() < deadline) {
      const s = await body<{ status: string; error?: string }>(
        await this.deps.cloud(`/v1/cloud/oauth/sessions/${encodeURIComponent(sessionId)}`),
      );
      if (s.status === "completed") return;
      if (s.status === "failed") throw new ServerSignInError(s.error || "Sign-in failed", 400);
      if (s.status === "expired") throw new ServerSignInError("Sign-in took too long. Try again.", 410);
      await sleep(this.deps.pollMs ?? 1500, signal);
    }
    throw new ServerSignInError("Sign-in took too long. Try again.", 410);
  }

  /** A credential with a usable access token, or null when this caller has no such connection. */
  /**
   * `rejectedAccessToken`: the token the provider just refused. The server only
   * refreshes if it is still the current one, so several Macs hitting the same
   * 401 cause one refresh (safe with rotating refresh tokens). Only its hash is sent.
   */
  async claim(serverId: string, force = false, rejectedAccessToken?: string): Promise<McpStoredCredential | null> {
    const rejectedTokenSha = rejectedAccessToken ? createHash("sha256").update(rejectedAccessToken).digest("hex") : undefined;
    const res = await this.deps.cloud("/v1/cloud/oauth/refresh/claim", {
      method: "POST",
      body: { serverId, force, ...(rejectedTokenSha ? { rejectedTokenSha } : {}) },
    });
    if (res.status === 404) return null;
    const out = await body<{ credential: McpStoredCredential }>(res);
    return { ...out.credential, serverRefresh: true };
  }

  /** Server-managed connections this caller can use. */
  async list(): Promise<Array<{ serverId: string; status: string; audience?: string }>> {
    return (await body<{ connections: Array<{ serverId: string; status: string; audience?: string }> }>(
      await this.deps.cloud("/v1/cloud/oauth/connections"),
    )).connections ?? [];
  }
}
