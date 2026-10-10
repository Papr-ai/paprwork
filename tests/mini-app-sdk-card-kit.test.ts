// @vitest-environment happy-dom
/**
 * Card kit behavior in a DOM, driven by the reference MCP Apps host (AppBridge):
 * frame + theme, unchanged fetch('/api/*'), approval gate, mac notice, Open in Papr.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { card, initials, parseActionResult } from "../src/resources/mini-app-sdk/papr-card.ts";
import { readForm, renderForm, renderValue } from "../src/resources/mini-app-sdk/papr-card-views.ts";
import { connectToReferenceHost } from "./helpers/mcpAppsReferenceHost.ts";

type Api = { path: string; method: string; body?: unknown };

async function mountCard(opts: Parameters<typeof card>[0], api: (a: Api) => { status: number; body: unknown }) {
  const calls: Api[] = [];
  const links: string[] = [];
  const contexts: string[] = [];
  const { host, port } = await connectToReferenceHost((h: AppBridge) => {
    h.oncalltool = async (p) => {
      const a = p.arguments as unknown as Api;
      calls.push(a);
      return { content: [], structuredContent: api(a) as unknown as Record<string, unknown> };
    };
    h.onopenlink = async (p) => (links.push(p.url), {});
    h.onupdatemodelcontext = async (p) => (contexts.push(String((p.content?.[0] as { text?: string })?.text)), {});
  });
  const fetchBefore = globalThis.fetch;
  const ctx = await card(opts, { port });
  const open = (sc: Record<string, unknown>) => host.sendToolResult({ content: [], structuredContent: sc });
  return { ctx, host, calls, links, contexts, open, fetchBefore };
}

const $ = (id: string) => document.getElementById(id) as HTMLButtonElement;
const APP = { namespaceId: "ns1", slug: "linkedin-outreach", title: "LinkedIn Outreach", publisher: "Amir", openUrl: "https://apps.papr.ai/ns1/linkedin-outreach" };

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = `<div id="papr-card"></div>`;
  delete (globalThis as { __paprMcpTransport?: boolean }).__paprMcpTransport;
});

describe("card kit", () => {
  it("draws the Papr frame, applies host theme, and lets unchanged app code fetch /api", async () => {
    const m = await mountCard(
      {
        async render({ body }) {
          const r = await fetch("/api/db/query", { method: "POST", body: JSON.stringify({ sql: "SELECT count(*) n FROM replies" }) });
          const { rows } = (await r.json()) as { rows: Array<{ n: number }> };
          body.innerHTML = `<p id="n">${rows[0].n} replies</p>`;
        },
      },
      () => ({ status: 200, body: { rows: [{ n: 3 }] } }),
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    await m.open(APP);
    await vi.waitFor(() => expect(document.getElementById("n")?.textContent).toBe("3 replies"));
    expect($("pc-title").textContent).toBe("LinkedIn Outreach");
    expect($("pc-pub").textContent).toBe("by Amir");
    expect($("pc-tile").textContent).toBe("LO");
    expect(m.calls[0]).toMatchObject({ namespaceId: "ns1", slug: "linkedin-outreach", method: "POST", path: "/api/db/query" });

    $("pc-open").click();
    await vi.waitFor(() => expect(m.links).toEqual([APP.openUrl]));
  });

  it("asks before an external action runs, then runs it and tells Claude", async () => {
    const m = await mountCard(
      { primary: { label: "Send replies", action: "send-replies", effect: "external" }, render: ({ body }) => void (body.textContent = "3 ready") },
      (a) => ({ status: 200, body: a.path.startsWith("/api/app/backend/") ? { stdout: '{"sent":3}', stderr: "", exitCode: 0 } : {} }),
    );
    await m.open(APP);
    await vi.waitFor(() => expect($("pc-go").textContent).toBe("Send replies"));

    $("pc-go").click();
    expect($("pc-go").textContent).toBe("Approve");
    expect(document.querySelector(".pc-confirm")?.textContent).toMatch(/send replies outside Papr/);
    expect(m.calls.filter((c) => c.path.includes("backend"))).toHaveLength(0);

    $("pc-cancel").click();
    expect($("pc-go").textContent).toBe("Send replies");

    $("pc-go").click();
    $("pc-go").click();
    await vi.waitFor(() => expect(m.calls.some((c) => c.path === "/api/app/backend/send-replies")).toBe(true));
    await vi.waitFor(() => expect(m.contexts).toEqual(["Send replies: done in LinkedIn Outreach."]));
  });

  it("runs write actions in one click and says when work runs on the Mac", async () => {
    const m = await mountCard(
      { primary: { label: "Scan now", action: "scan", runsOn: "mac" }, render: () => {} },
      () => ({ status: 200, body: { stdout: "", stderr: "", exitCode: 0 } }),
    );
    await m.open(APP);
    await vi.waitFor(() => expect($("pc-note").textContent).toMatch(/Mac/));
    $("pc-go").click();
    await vi.waitFor(() => expect(m.calls.some((c) => c.path === "/api/app/backend/scan")).toBe(true));
  });

  it("shows action failures without losing the button", async () => {
    const m = await mountCard(
      { primary: { label: "Scan now", action: "scan" }, render: () => {} },
      () => ({ status: 200, body: { stdout: "", stderr: "Traceback\nValueError: no LinkedIn session", exitCode: 1 } }),
    );
    await m.open(APP);
    await vi.waitFor(() => expect($("pc-go")).toBeTruthy());
    $("pc-go").click();
    await vi.waitFor(() => expect($("pc-note").textContent).toBe("ValueError: no LinkedIn session"));
    expect($("pc-go").textContent).toBe("Scan now");
  });

  it("explains when the tool result has no app", async () => {
    const m = await mountCard({ render: () => {} }, () => ({ status: 200, body: {} }));
    await m.host.sendToolResult({ content: [{ type: "text", text: "You don't have access to that Papr app." }], isError: true });
    await vi.waitFor(() => expect(document.querySelector(".pc-err")?.textContent).toMatch(/don't have access/));
  });
});

describe("default view helpers", () => {
  it("renders scalars, objects and tables, escaping content", () => {
    expect(renderValue(42)).toBe("<p>42</p>");
    expect(renderValue({ leads: 12 })).toContain("<dt>Leads</dt><dd>12</dd>");
    const table = renderValue([{ name: "<b>Ana</b>", score: 9 }]);
    expect(table).toContain("<th>Name</th>");
    expect(table).toContain("&lt;b&gt;Ana&lt;/b&gt;");
    expect(renderValue([])).toContain("Nothing yet");
  });

  it("builds a form from the input schema and reads required fields", () => {
    const schema = { type: "object" as const, properties: { topic: { type: "string" as const }, urgent: { type: "boolean" as const } }, required: ["topic"] };
    document.body.innerHTML = renderForm(schema);
    const form = document.querySelector("form");
    expect(readForm(form, schema)).toBeNull();
    (form!.elements.namedItem("topic") as HTMLInputElement).value = "AI hiring";
    expect(readForm(form, schema)).toEqual({ topic: "AI hiring", urgent: "false" });
  });

  it("parses action output", () => {
    expect(parseActionResult({ stdout: '{"a":1}', stderr: "", exitCode: 0 })).toEqual({ a: 1 });
    expect(parseActionResult({ stdout: "done", stderr: "", exitCode: 0 })).toBe("done");
    expect(() => parseActionResult({ stdout: "", stderr: "boom", exitCode: 2 })).toThrow("boom");
    expect(initials("new-shelf")).toBe("NS");
  });
});
