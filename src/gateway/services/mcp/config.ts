/**
 * Config for the Claude-facing MCP endpoint mounted on the Cloud App Host.
 *
 * The endpoint is an OAuth 2.1 protected resource (MCP auth spec, RFC 9728):
 * Claude discovers Auth0 from our protected-resource metadata, signs the user in,
 * and sends an Auth0 access token whose audience is this resource.
 */
import { normalizeAuth0Domain } from "../../../core/utils/paprAuth0Pkce.js";

export interface McpEndpointConfig {
  /** Canonical resource URL Claude connects to, e.g. https://mcp.papr.ai/mcp. */
  resourceUrl: string;
  /** Auth0 issuer, e.g. https://papr.auth0.com/ (trailing slash, as Auth0 issues it). */
  issuer: string;
  /** Access-token audience. Auth0 API identifier registered for the MCP resource. */
  audience: string;
  /** Public base for "Open in Papr" links, e.g. https://apps.papr.ai. */
  appsBaseUrl: string;
  /** Port this process listens on; the api tunnel dispatches to it over loopback. */
  loopbackPort: number;
  /** Shared secret for memory's /v1/cloud/mcp/session. Unset → claims bridge (spike only). */
  serviceKey?: string;
}

export const MCP_PATH = "/mcp";

export function loadMcpEndpointConfig(loopbackPort: number): McpEndpointConfig {
  const domain = normalizeAuth0Domain(process.env.AUTH0_DOMAIN || "papr.auth0.com");
  const resourceUrl = (process.env.PAPR_MCP_RESOURCE_URL || "https://mcp.papr.ai/mcp").replace(/\/$/, "");
  return {
    resourceUrl,
    issuer: `https://${domain}/`,
    audience: process.env.PAPR_MCP_AUDIENCE || resourceUrl,
    appsBaseUrl: (process.env.PAPR_CLOUD_APPS_PUBLIC_URL || "https://apps.papr.ai").replace(/\/$/, ""),
    loopbackPort,
    serviceKey: process.env.PAPR_MCP_SERVICE_KEY?.trim() || undefined,
  };
}

/** RFC 9728 path-suffixed metadata URL: /.well-known/oauth-protected-resource/mcp */
export function protectedResourceMetadataUrl(cfg: McpEndpointConfig): string {
  const u = new URL(cfg.resourceUrl);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
}

export function isMcpEndpointEnabled(): boolean {
  return process.env.PAPR_MCP_ENABLED === "1" || process.env.PAPR_MCP_ENABLED === "true";
}
