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
  /** UI grouping (Projects, CRM, Finance, Engineering…). */
  category?: string;
  /** Full sign-in + tool call confirmed end-to-end (not just registration). */
  verified?: boolean;
  /** No dynamic client registration — needs a pre-registered client id. */
  requiresClientId?: boolean;
  /** Pre-registered public client id (when the server lacks DCR). */
  clientId?: string;
  /** Added by the user/agent rather than shipped. */
  custom?: boolean;
}

export const BUILTIN_MCP_SERVERS: readonly McpServerDefinition[] = [
  // One-click: dynamic client registration accepted a loopback redirect (probed Oct 2026).
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", transport: "streamable-http", category: "Projects", description: "Issues, projects, cycles, comments", verified: true },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", transport: "streamable-http", category: "Docs", description: "Pages, databases, search" },
  { id: "atlassian", name: "Atlassian", url: "https://mcp.atlassian.com/v1/sse", transport: "sse", category: "Projects", description: "Jira + Confluence" },
  { id: "asana", name: "Asana", url: "https://mcp.asana.com/sse", transport: "sse", category: "Projects", description: "Tasks, projects, goals" },
  { id: "monday", name: "Monday", url: "https://mcp.monday.com/mcp", transport: "streamable-http", category: "Projects", description: "Boards, items, updates" },
  { id: "clickup", name: "ClickUp", url: "https://mcp.clickup.com/mcp", transport: "streamable-http", category: "Projects", description: "Tasks, docs, spaces" },
  { id: "todoist", name: "Todoist", url: "https://ai.todoist.net/mcp", transport: "streamable-http", category: "Projects", description: "Tasks and projects" },
  { id: "airtable", name: "Airtable", url: "https://mcp.airtable.com/mcp", transport: "streamable-http", category: "Data", description: "Bases, tables, records" },
  { id: "miro", name: "Miro", url: "https://mcp.miro.com/", transport: "streamable-http", category: "Design", description: "Boards and diagrams" },
  { id: "canva", name: "Canva", url: "https://mcp.canva.com/mcp", transport: "streamable-http", category: "Design", description: "Designs, assets, brand kits" },
  { id: "webflow", name: "Webflow", url: "https://mcp.webflow.com/mcp", transport: "streamable-http", category: "Content", description: "Sites, CMS collections" },
  { id: "wix", name: "Wix", url: "https://mcp.wix.com/mcp", transport: "streamable-http", category: "Content", description: "Sites, stores, bookings" },
  { id: "sanity", name: "Sanity", url: "https://mcp.sanity.io", transport: "streamable-http", category: "Content", description: "Content lake, documents" },
  { id: "contentful", name: "Contentful", url: "https://mcp.contentful.com/mcp", transport: "streamable-http", category: "Content", description: "Entries, assets, spaces" },
  { id: "cloudinary", name: "Cloudinary", url: "https://asset-management.mcp.cloudinary.com/sse", transport: "sse", category: "Content", description: "Media assets" },
  { id: "egnyte", name: "Egnyte", url: "https://mcp-server.egnyte.com/mcp", transport: "streamable-http", category: "Docs", description: "Files and folders" },
  { id: "granola", name: "Granola", url: "https://mcp.granola.ai/mcp", transport: "streamable-http", category: "Meetings", description: "Meeting notes" },
  { id: "fireflies", name: "Fireflies", url: "https://api.fireflies.ai/mcp", transport: "streamable-http", category: "Meetings", description: "Meeting transcripts" },
  { id: "intercom", name: "Intercom", url: "https://mcp.intercom.com/mcp", transport: "streamable-http", category: "Support", description: "Conversations, contacts" },
  { id: "attio", name: "Attio", url: "https://mcp.attio.com/mcp", transport: "streamable-http", category: "CRM", description: "Records, lists, notes" },
  { id: "close", name: "Close", url: "https://mcp.close.com/mcp", transport: "streamable-http", category: "CRM", description: "Leads, opportunities, calls" },
  { id: "apollo", name: "Apollo", url: "https://mcp.apollo.io/mcp", transport: "streamable-http", category: "CRM", description: "Prospecting, contacts, sequences" },
  { id: "klaviyo", name: "Klaviyo", url: "https://mcp.klaviyo.com/mcp", transport: "streamable-http", category: "Marketing", description: "Campaigns, flows, profiles" },
  { id: "bitly", name: "Bitly", url: "https://api-ssl.bitly.com/v4/mcp", transport: "streamable-http", category: "Marketing", description: "Short links, analytics" },
  { id: "stripe", name: "Stripe", url: "https://mcp.stripe.com", transport: "streamable-http", category: "Finance", description: "Customers, payments, billing" },
  { id: "paypal", name: "PayPal", url: "https://mcp.paypal.com/mcp", transport: "streamable-http", category: "Finance", description: "Payments, invoices, orders" },
  { id: "square", name: "Square", url: "https://mcp.squareup.com/sse", transport: "sse", category: "Finance", description: "Payments, catalog, orders" },
  { id: "plaid", name: "Plaid", url: "https://api.dashboard.plaid.com/mcp/sse", transport: "sse", category: "Finance", description: "Plaid dashboard, items" },
  { id: "mercury", name: "Mercury", url: "https://mcp.mercury.com/mcp", transport: "streamable-http", category: "Finance", description: "Bank accounts, transactions" },
  { id: "ramp", name: "Ramp", url: "https://mcp.ramp.com/mcp", transport: "streamable-http", category: "Finance", description: "Spend, cards, bills" },
  { id: "amplitude", name: "Amplitude", url: "https://mcp.amplitude.com/mcp", transport: "streamable-http", category: "Analytics", description: "Charts, events, cohorts" },
  { id: "mixpanel", name: "Mixpanel", url: "https://mcp.mixpanel.com/mcp", transport: "streamable-http", category: "Analytics", description: "Events, funnels, reports" },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", transport: "streamable-http", category: "Engineering", description: "Issues, events, releases" },
  { id: "datadog", name: "Datadog", url: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp", transport: "streamable-http", category: "Engineering", description: "Metrics, logs, monitors" },
  { id: "honeycomb", name: "Honeycomb", url: "https://mcp.honeycomb.io/mcp", transport: "streamable-http", category: "Engineering", description: "Traces and queries" },
  { id: "jam", name: "Jam", url: "https://mcp.jam.dev/mcp", transport: "streamable-http", category: "Engineering", description: "Bug reports" },
  { id: "vercel", name: "Vercel", url: "https://mcp.vercel.com", transport: "streamable-http", category: "Engineering", description: "Projects, deployments, logs" },
  { id: "netlify", name: "Netlify", url: "https://netlify-mcp.netlify.app/mcp", transport: "streamable-http", category: "Engineering", description: "Sites, deploys" },
  { id: "cloudflare", name: "Cloudflare", url: "https://bindings.mcp.cloudflare.com/mcp", transport: "streamable-http", category: "Engineering", description: "Workers, KV, R2, D1" },
  { id: "railway", name: "Railway", url: "https://mcp.railway.com/mcp", transport: "streamable-http", category: "Engineering", description: "Projects, services, deploys" },
  { id: "supabase", name: "Supabase", url: "https://mcp.supabase.com/mcp", transport: "streamable-http", category: "Engineering", description: "Projects, SQL, edge functions" },
  { id: "neon", name: "Neon", url: "https://mcp.neon.tech/mcp", transport: "streamable-http", category: "Engineering", description: "Postgres projects, branches" },
  { id: "prisma", name: "Prisma", url: "https://mcp.prisma.io/mcp", transport: "streamable-http", category: "Engineering", description: "Prisma Postgres" },
  { id: "retool", name: "Retool", url: "https://mcp.retool.com/mcp", transport: "streamable-http", category: "Engineering", description: "Apps and workflows" },
  { id: "resend", name: "Resend", url: "https://mcp.resend.com/mcp", transport: "streamable-http", category: "Engineering", description: "Transactional email" },
  { id: "huggingface", name: "Hugging Face", url: "https://huggingface.co/mcp", transport: "streamable-http", category: "AI", description: "Models, datasets, spaces" },
  { id: "context7", name: "Context7", url: "https://mcp.context7.com/mcp", transport: "streamable-http", category: "AI", description: "Up-to-date library docs" },
  { id: "exa", name: "Exa", url: "https://mcp.exa.ai/mcp", transport: "streamable-http", category: "AI", description: "Web search" },
  { id: "zapier", name: "Zapier", url: "https://mcp.zapier.com/api/mcp/mcp", transport: "streamable-http", category: "Automation", description: "Actions across 7,000+ apps" },
  { id: "make", name: "Make", url: "https://mcp.make.com", transport: "streamable-http", category: "Automation", description: "Scenarios" },
  // OAuth without DCR: need a registered Papr Work client id (set clientId to enable).
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", transport: "streamable-http", category: "Engineering", description: "Repos, issues, PRs", requiresClientId: true },
  { id: "slack", name: "Slack", url: "https://mcp.slack.com/mcp", transport: "streamable-http", category: "Communication", description: "Channels, messages, search", requiresClientId: true },
  { id: "hubspot", name: "HubSpot", url: "https://mcp.hubspot.com/", transport: "streamable-http", category: "CRM", description: "Contacts, companies, deals", requiresClientId: true },
  { id: "googledrive", name: "Google Drive", url: "https://drivemcp.googleapis.com/mcp", transport: "streamable-http", category: "Docs", description: "Files and folders", requiresClientId: true },
  { id: "box", name: "Box", url: "https://mcp.box.com", transport: "streamable-http", category: "Docs", description: "Files and folders", requiresClientId: true },
  { id: "docusign", name: "DocuSign", url: "https://mcp.docusign.com/mcp", transport: "streamable-http", category: "Docs", description: "Envelopes, agreements", requiresClientId: true },
  { id: "zendesk", name: "Zendesk", url: "https://mcp.zendesk.com/mcp", transport: "streamable-http", category: "Support", description: "Tickets, users", requiresClientId: true },
  { id: "smartsheet", name: "Smartsheet", url: "https://mcp.smartsheet.com/mcp", transport: "streamable-http", category: "Projects", description: "Sheets, rows", requiresClientId: true },
  { id: "render", name: "Render", url: "https://mcp.render.com/mcp", transport: "streamable-http", category: "Engineering", description: "Services, deploys", requiresClientId: true },
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
