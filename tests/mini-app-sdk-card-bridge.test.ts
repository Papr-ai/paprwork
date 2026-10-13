/**
 * Conformance: our 3 KB MCP Apps client against the reference host (ext-apps AppBridge),
 * plus the transport that reroutes an unchanged app's fetch/EventSource via papr_api.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHostBridge } from "../src/resources/mini-app-sdk/papr-mcp-bridge.ts";
import {
  apiPathOf,
  createTunnelFetch,
  installMcpTransport,
  PollingJobEvents,
  type CallTool,
} from "../src/resources/mini-app-sdk/papr-mcp-transport.ts";
import { connectToReferenceHost } from "./helpers/mcpAppsReferenceHost.ts";

describe("McpHostBridge vs ext-apps AppBridge", () => {
  it("initializes and receives host context", async () => {
    const initialized = vi.fn();
    const { port } = await connectToReferenceHost((h) => (h.oninitialized = initialized));
    const bridge = new McpHostBridge(port);
    const ctx = await bridge.connect();
    expect(ctx.theme).toBe("dark");
    await vi.waitFor(() => expect(initialized).toHaveBeenCalled());
  });

  it("gets tool results, calls server tools, opens links, updates model context", async () => {
    const calls: unknown[] = [];
    const links: string[] = [];
    const contexts: unknown[] = [];
    const { host, port } = await connectToReferenceHost((h) => {
      h.oncalltool = async (p) => {
        calls.push(p);
        return { content: [{ type: "text", text: "ok" }], structuredContent: { status: 200, body: { rows: [] } } };
      };
      h.onopenlink = async (p) => (links.push(p.url), {});
      h.onupdatemodelcontext = async (p) => (contexts.push(p), {});
    });
    const bridge = new McpHostBridge(port);
    const results: unknown[] = [];
    bridge.onToolResult = (r) => results.push(r);
    await bridge.connect();

    await host.sendToolResult({ content: [], structuredContent: { namespaceId: "ns1", slug: "a" } });
    await vi.waitFor(() => expect(results).toHaveLength(1));

    const r = await bridge.callTool("papr_api", { path: "/api/access" });
    expect(r.structuredContent).toEqual({ status: 200, body: { rows: [] } });
    expect(calls).toEqual([{ name: "papr_api", arguments: { path: "/api/access" } }]);

    await bridge.openLink("https://apps.papr.ai/ns1/a");
    expect(links).toEqual(["https://apps.papr.ai/ns1/a"]);

    await bridge.updateModelContext("3 replies waiting");
    expect(contexts).toEqual([{ content: [{ type: "text", text: "3 replies waiting" }] }]);
  });

  it("follows host theme changes", async () => {
    const { host, port } = await connectToReferenceHost();
    const bridge = new McpHostBridge(port);
    const seen: string[] = [];
    bridge.onHostContext = (c) => seen.push(String(c.theme));
    await bridge.connect();
    host.setHostContext({ theme: "light" } as never);
    await vi.waitFor(() => expect(seen).toEqual(["light"]));
  });
});

describe("MCP transport", () => {
  const ref = { namespaceId: "ns1", slug: "outreach" };
  const ok = (body: unknown, status = 200) => ({ content: [], structuredContent: { status, body } });

  it("recognizes app API URLs only", () => {
    expect(apiPathOf("/api/db/query")).toBe("/api/db/query");
    expect(apiPathOf("/api/jobs/status/j1?x=1")).toBe("/api/jobs/status/j1?x=1");
    expect(apiPathOf("https://cdn.example.com/api/x")).toBeNull();
    expect(apiPathOf("/static/app.css")).toBeNull();
  });

  it("tunnels fetch('/api/…') and passes other URLs through", async () => {
    const callTool = vi.fn<CallTool>(async () => ok({ rows: [{ n: 1 }] }));
    const real = vi.fn(async () => new Response("cdn"));
    const f = createTunnelFetch({ callTool, ref }, real as unknown as typeof fetch);

    const res = await f("/api/db/query", { method: "POST", body: JSON.stringify({ sql: "SELECT 1" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [{ n: 1 }] });
    expect(callTool).toHaveBeenCalledWith("papr_api", { namespaceId: "ns1", slug: "outreach", method: "POST", path: "/api/db/query", body: { sql: "SELECT 1" } });

    await f("https://cdn.example.com/lib.js");
    expect(real).toHaveBeenCalledTimes(1);
  });

  it("keeps HTTP errors as HTTP errors and waits for the app ref", async () => {
    let setRef!: (r: typeof ref) => void;
    const pending = new Promise<typeof ref>((r) => (setRef = r));
    const callTool = vi.fn<CallTool>(async () => ok({ error: "Forbidden" }, 403));
    const f = createTunnelFetch({ callTool, ref: pending }, fetch);
    const p = f("/api/access");
    expect(callTool).not.toHaveBeenCalled();
    setRef(ref);
    const res = await p;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("rejects non-JSON bodies and methods the tunnel doesn't carry", async () => {
    const f = createTunnelFetch({ callTool: async () => ok({}), ref }, fetch);
    await expect(f("/api/files", { method: "POST", body: new Blob(["x"]) as unknown as BodyInit })).rejects.toThrow(/JSON/);
    await expect(f("/api/db/query", { method: "DELETE" })).rejects.toThrow(/not available/);
  });

  it("emulates job events by polling status, reporting only changes", async () => {
    const statuses = ["running", "running", "completed"];
    const callTool = vi.fn<CallTool>(async () => ok({ status: statuses.shift(), name: "Scan" }));
    const es = new PollingJobEvents("/api/jobs/events?jobIds=j1", { callTool, ref, pollMs: 60_000 });
    const events: unknown[] = [];
    es.addEventListener("jobs:status-changed", (ev) => events.push(JSON.parse(String(ev.data))));
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
    await es.poll(["j1"]);
    await es.poll(["j1"]);
    es.close();
    expect(events).toEqual([{ jobId: "j1", status: "completed", name: "Scan" }]);
    expect(callTool).toHaveBeenLastCalledWith("papr_api", expect.objectContaining({ method: "GET", path: "/api/jobs/status/j1" }));
  });

  it("installs on a window, routes EventSource for job events, and uninstalls", () => {
    const realFetch = vi.fn();
    class RealES { constructor(public url: string) {} }
    const win = { fetch: realFetch, EventSource: RealES, location: { href: "https://sandbox.claude.invalid/card" } } as unknown as typeof globalThis;
    const off = installMcpTransport({ callTool: async () => ok({}), ref, win });
    expect(win.fetch).not.toBe(realFetch);
    const es = new win.EventSource("/api/jobs/events");
    expect(es).toBeInstanceOf(PollingJobEvents);
    expect(new win.EventSource("https://other.example/stream")).toBeInstanceOf(RealES);
    (es as unknown as PollingJobEvents).close();
    off();
    expect(win.EventSource).toBe(RealES);
  });
});

afterEach(() => vi.useRealTimers());
