/**
 * Remote MCP servers Paprwork knows how to sign in to.
 *
 * Every entry here was probed (Oct 2026): unauthenticated `initialize` → 401,
 * protected-resource metadata present, and — except where `clientId` is noted —
 * dynamic client registration accepted a loopback `http://127.0.0.1` redirect.
 * That last property is what makes one-click sign-in work with no per-service
 * OAuth app: the client registers itself on first connect.
 *
 * Servers without DCR (GitHub, HubSpot) need a pre-registered public client id;
 * they are listed with `requiresClientId` so the UI can say so instead of
 * failing mid-flow.
 */

export type McpTransportKind = "streamable-http" | "sse";

export interface McpServerDefinition {
  /** Stable id: lowercase, [a-z0-9-]. Prefixes every tool (`linear__create_issue`). */
  id: string;
  name: string;
  url: string;
  transport: McpTransportKind;
  description?: string;
  /** No dynamic client registration — needs a pre-registered client id. */
  requiresClientId?: boolean;
  /** Pre-registered public client id (when the server lacks DCR). */
  clientId?: string;
  /** Added by the user/agent rather than shipped. */
  custom?: boolean;
}

export const BUILTIN_MCP_SERVERS: readonly McpServerDefinition[] = [
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", transport: "streamable-http", description: "Issues, projects, cycles, comments" },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", transport: "streamable-http", description: "Pages, databases, search" },
  { id: "atlassian", name: "Atlassian", url: "https://mcp.atlassian.com/v1/sse", transport: "sse", description: "Jira + Confluence" },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", transport: "streamable-http", description: "Issues, events, releases" },
  { id: "asana", name: "Asana", url: "https://mcp.asana.com/sse", transport: "sse", description: "Tasks, projects" },
  { id: "stripe", name: "Stripe", url: "https://mcp.stripe.com", transport: "streamable-http", description: "Customers, payments, billing" },
  { id: "cloudflare", name: "Cloudflare", url: "https://bindings.mcp.cloudflare.com/mcp", transport: "streamable-http", description: "Workers, KV, R2, D1" },
  { id: "intercom", name: "Intercom", url: "https://mcp.intercom.com/mcp", transport: "streamable-http", description: "Conversations, contacts" },
  { id: "canva", name: "Canva", url: "https://mcp.canva.com/mcp", transport: "streamable-http", description: "Designs, assets" },
  { id: "vercel", name: "Vercel", url: "https://mcp.vercel.com", transport: "streamable-http", description: "Projects, deployments, logs" },
  { id: "hubspot", name: "HubSpot", url: "https://mcp.hubspot.com/", transport: "streamable-http", description: "CRM contacts, companies, deals", requiresClientId: true },
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", transport: "streamable-http", description: "Repos, issues, PRs", requiresClientId: true },
];

const SERVER_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

export function isValidMcpServerId(id: string): boolean {
  return SERVER_ID_RE.test(id);
}

/** Derive a server id from a URL host, e.g. https://mcp.linear.app/mcp → "linear". */
export function deriveMcpServerId(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  const parts = host.split(".").filter((p) => !["mcp", "www", "api", "com", "app", "dev", "io", "ai", "net", "org", "co"].includes(p));
  const base = (parts[0] ?? host).replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "");
  return (base || "custom").slice(0, 31);
}

export function inferMcpTransport(url: string): McpTransportKind {
  return /\/sse\/?$/.test(new URL(url).pathname) ? "sse" : "streamable-http";
}

/** Keychain key holding one server's OAuth state (client registration + tokens). */
export function mcpCredentialKeyName(serverId: string): string {
  return `MCP_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_OAUTH`;
}
