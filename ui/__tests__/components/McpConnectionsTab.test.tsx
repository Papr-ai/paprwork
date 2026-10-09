import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

let keys: Array<{ id: string; name: string; vaultOrigin?: string; vaultAudience?: string }> = [];
vi.mock("../../hooks/useCustomKeys", () => ({ useCustomKeys: () => ({ keys }) }));
vi.mock("../../components/Settings/McpServerSheet", () => ({
  McpServerSheet: ({ server }: { server: { name: string } }) => <div>sheet:{server.name}</div>,
  mcpKeyName: (id: string) => `MCP_${id.toUpperCase()}_OAUTH`,
}));

let platforms: Array<Record<string, unknown>> = [];
const sitesApi = { connect: vi.fn(async () => {}), cancel: vi.fn() };
vi.mock("../../hooks/usePlatformConnections", () => ({
  PLATFORM_META: { linkedin: { domain: "linkedin.com", desc: "Posts, messages, profiles" }, reddit: { domain: "reddit.com", desc: "Posts" } },
  usePlatformConnections: () => ({
    platforms, loading: false, busy: null, waiting: new Set(), externalChrome: new Set(), error: null, notice: null,
    needsChromeFor: null, chrome: true, ...sitesApi,
  }),
}));
vi.mock("../../components/Settings/SiteSheet", () => ({
  SiteSheet: ({ site }: { site: { name: string } }) => <div>site:{site.name}</div>,
  AddSiteSheet: () => <div>add-site</div>,
  siteLogoServer: (p: { name: string }) => ({ name: p.name, url: "" }),
}));

import { McpConnectionsTab } from "../../components/Settings/McpConnectionsTab";

const P = (id: string, name: string, status = "disconnected") => ({ id, name, status: { platformId: id, status } });

const S = (id: string, name: string, state = "disconnected", extra: Record<string, unknown> = {}) => ({
  id, name, url: `https://mcp.${id}.com/mcp`, category: "Projects", description: `${name} things`,
  verified: true, custom: false, requiresClientId: false, state, toolCount: state === "connected" ? 12 : 0, ...extra,
});

let servers: ReturnType<typeof S>[] = [];
const calls: Array<{ url: string; method: string; body?: string }> = [];

beforeEach(() => {
  keys = [];
  platforms = [];
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    return new Response(JSON.stringify(url.endsWith("/api/mcp/servers") ? { servers } : {}), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("McpConnectionsTab (redesign)", () => {
  it("first visit: value sentence and one-click starts, no Connected list", { timeout: 20_000 }, async () => {
    servers = [S("notion", "Notion"), S("linear", "Linear"), S("github", "GitHub"), S("slack", "Slack")];
    render(<McpConnectionsTab embedded />);
    expect(await screen.findByText("Connect the tools you already use")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Linear" })[0]);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/linear/connect") && c.method === "POST")).toBe(true));
  });

  it("Connected sorts problems first; teammates' sign-ins go under Team", async () => {
    servers = [S("notion", "Notion", "connected"), S("linear", "Linear", "needs_reauth"), S("hubspot", "HubSpot", "connected"), S("asana", "Asana")];
    keys = [{ id: "k", name: "MCP_HUBSPOT_OAUTH", vaultOrigin: "shared" }];
    const counts: number[] = [];
    render(<McpConnectionsTab embedded onCount={(n) => counts.push(n)} />);
    const connected = (await screen.findByText("Connected")).closest("section")!;
    const names = within(connected).getAllByText(/^(Notion|Linear)$/).map((n) => n.textContent);
    expect(names).toEqual(["Linear", "Notion"]);
    expect(within(connected).getByText(/Sign-in expired/)).toBeTruthy();
    expect(within(connected).getByRole("button", { name: "Reconnect" })).toBeTruthy();
    const team = screen.getByText("Team").closest("section")!;
    expect(within(team).getByText("HubSpot")).toBeTruthy();
    expect(counts[counts.length - 1]).toBe(3);
  });

  it("Add a service: Popular by default, search, and blocked services offer Request", async () => {
    servers = [S("notion", "Notion"), S("linear", "Linear"), S("zzcrm", "Zz CRM", "disconnected", { category: "CRM" })];
    const org = {
      policy: { mode: "approved", approved: ["notion"], maxShare: "org", maxPenAccess: "full", setupBy: "admins" },
      isAdmin: false, requests: [], request: vi.fn(), cancel: vi.fn(),
    };
    render(<McpConnectionsTab embedded org={org as never} />);
    const add = (await screen.findByText("Add a service")).closest("section")!;
    expect(within(add).queryByText("Zz CRM")).toBeNull(); // not popular
    fireEvent.change(within(add).getByLabelText("Search services"), { target: { value: "crm" } });
    expect(within(add).getByText("Zz CRM")).toBeTruthy();
    expect(within(add).getByText("Not approved")).toBeTruthy();
    expect(within(add).getByRole("button", { name: "Request" })).toBeTruthy();
  });

  it("clicking a row opens its panel; the row's Connect button does not", async () => {
    servers = [S("notion", "Notion", "connected"), S("linear", "Linear")];
    render(<McpConnectionsTab embedded />);
    const add = (await screen.findByText("Add a service")).closest("section")!;
    fireEvent.click(within(add).getByRole("button", { name: "Connect" }));
    expect(screen.queryByText("sheet:Linear")).toBeNull();
    fireEvent.click(within(add).getByText("Linear"));
    expect(screen.getByText("sheet:Linear")).toBeTruthy();
  });

  it("website logins sit in the same list: connected ones under Connected, the rest under Add (Social)", async () => {
    servers = [S("notion", "Notion", "connected")];
    platforms = [P("linkedin", "LinkedIn", "connected"), P("reddit", "Reddit"), P("x", "X", "expired")];
    render(<McpConnectionsTab embedded />);
    const connected = (await screen.findByText("Connected")).closest("section")!;
    expect(within(connected).getAllByText(/^(X|Notion|LinkedIn)$/).map((n) => n.textContent)).toEqual(["X", "Notion", "LinkedIn"]);
    expect(within(connected).getByText("Connected · This Mac only")).toBeTruthy();
    expect(within(connected).getByRole("button", { name: "Reconnect" })).toBeTruthy();
    const add = screen.getByText("Add a service").closest("section")!;
    fireEvent.click(within(add).getByRole("tab", { name: "Social" }));
    expect(within(add).getByText("Reddit")).toBeTruthy();
    expect(within(add).getByText("Browser")).toBeTruthy();
    fireEvent.click(within(add).getByText("Reddit"));
    expect(screen.getByText("site:Reddit")).toBeTruthy();
  });

  it("+ Website login opens the add form", async () => {
    servers = [S("notion", "Notion", "connected")];
    render(<McpConnectionsTab embedded />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Website login" }));
    expect(screen.getByText("add-site")).toBeTruthy();
  });
});
