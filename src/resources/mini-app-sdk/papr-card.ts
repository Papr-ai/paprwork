/**
 * Papr card kit: how a Papr app looks inside Claude.
 *
 *   import { card } from '/__papr__/papr-card.ts';
 *   card({
 *     primary: { label: 'Send replies', action: 'send-replies', effect: 'external' },
 *     async render({ body, api }) {
 *       const { rows } = await (await fetch('/api/db/query', {...})).json();  // works unchanged
 *       body.innerHTML = `<p>${rows.length} replies waiting</p>`;
 *     },
 *   });
 *
 * The kit owns the frame so every card looks like Papr and stays safe by default:
 *   - header: app tile, name, publisher, "Built on Papr"
 *   - footer: at most one primary action + "Open in Papr"
 *   - effect: 'external' → the primary asks for approval before it runs
 *   - runsOn: 'mac'      → says so, since it runs when the user's Mac is awake
 *   - Claude's theme (light/dark + host CSS variables) applied automatically
 * fetch('/api/*') and job events are rerouted through papr_api (papr-mcp-transport).
 */

import { McpHostBridge, windowPort, type BridgePort, type HostContext, type ToolResult } from "./papr-mcp-bridge.ts";
import { installMcpTransport, tunnelRequest, type AppRef } from "./papr-mcp-transport.ts";
import { CARD_CSS } from "./papr-card-style.ts";

export type CardEffect = "read" | "write" | "external";

export interface CardPrimary {
  label: string;
  /** Backend action name from backend/manifest.json. */
  action: string;
  effect?: CardEffect;
  runsOn?: "cloud" | "mac";
  /** Params for the action; return null to keep the button disabled. */
  params?: (ctx: CardContext) => Record<string, string> | null;
  /** Approval copy for effect: 'external'. */
  confirmText?: string;
}

/** What the open tool tells the card (structuredContent). */
export interface CardAppInfo extends AppRef {
  title?: string;
  publisher?: string;
  openUrl?: string;
  view?: string;
  data?: Record<string, unknown>;
}

export interface CardContext {
  app: CardAppInfo;
  data: Record<string, unknown>;
  body: HTMLElement;
  theme: "light" | "dark";
  api: (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>;
  run: (action: string, params?: Record<string, string>) => Promise<unknown>;
  refresh: () => Promise<void>;
  setPrimary: (primary: CardPrimary | null) => void;
  tellClaude: (text: string) => void;
}

export interface CardOptions {
  primary?: CardPrimary;
  render: (ctx: CardContext) => void | Promise<void>;
  onResult?: (result: unknown, ctx: CardContext) => void | Promise<void>;
}

export interface CardDeps {
  port?: BridgePort;
  doc?: Document;
  win?: typeof globalThis;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function initials(title: string): string {
  const words = title.replace(/[-_]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "P").slice(0, 2)).toUpperCase();
}

/** Runs a backend action and returns its parsed JSON output (or raw stdout). */
export function parseActionResult(body: unknown): unknown {
  const r = body as { stdout?: string; stderr?: string; exitCode?: number; error?: string } | null;
  if (!r || typeof r !== "object" || !("exitCode" in r)) return body;
  if (r.exitCode !== 0) throw new Error((r.stderr || r.error || "Action failed").trim().split("\n").pop());
  const out = (r.stdout ?? "").trim();
  try {
    return out ? JSON.parse(out) : null;
  } catch {
    return out;
  }
}

function applyTheme(doc: Document, ctx: HostContext): "light" | "dark" {
  const root = doc.documentElement;
  for (const [k, v] of Object.entries(ctx.styles?.variables ?? {})) if (v) root.style.setProperty(k, v);
  const theme = ctx.theme === "dark" ? "dark" : "light";
  root.dataset.theme = theme;
  return theme;
}

function frameHtml(): string {
  return `<div class="pc"><header class="pc-h"><span class="pc-tile" id="pc-tile">P</span>
<div class="pc-t"><b id="pc-title">Papr</b><em id="pc-pub">Loading…</em></div><span class="pc-by">Built on <b>Papr</b></span></header>
<main class="pc-b" id="pc-body"><p class="pc-mu">Waiting for Claude…</p></main>
<footer class="pc-f"><span class="pc-note" id="pc-note"></span><span class="pc-act" id="pc-act"></span>
<button class="pc-btn pc-ghost" id="pc-open" disabled>Open in Papr</button></footer></div>`;
}

export async function card(opts: CardOptions, deps: CardDeps = {}): Promise<CardContext> {
  const doc = deps.doc ?? document;
  const win = deps.win ?? globalThis;
  const bridge = new McpHostBridge(deps.port ?? windowPort(win as unknown as Window));
  const style = doc.createElement("style");
  style.textContent = CARD_CSS;
  doc.head.appendChild(style);
  const mount = doc.getElementById("papr-card") ?? doc.body;
  mount.innerHTML = frameHtml();
  const $ = (id: string): HTMLElement => doc.getElementById(id)!;

  let resolveRef!: (r: AppRef) => void;
  const refReady = new Promise<AppRef>((r) => (resolveRef = r));
  const callTool = (name: string, args: Record<string, unknown>): Promise<ToolResult> => bridge.callTool(name, args);
  installMcpTransport({ callTool, ref: refReady, win });

  let primary: CardPrimary | null = opts.primary ?? null;
  let armed = false;
  const ctx: CardContext = {
    app: { namespaceId: "", slug: "" },
    data: {},
    body: $("pc-body"),
    theme: "light",
    async api(method, path, body) {
      const r = await tunnelRequest(callTool, refReady, method, path, body);
      if (r.status >= 400) throw new Error((r.body as { error?: string })?.error ?? `HTTP ${r.status}`);
      return r.body;
    },
    async run(action, params) {
      const body = await ctx.api("POST", `/api/app/backend/${encodeURIComponent(action)}`, params ? { params } : {});
      return parseActionResult(body);
    },
    async refresh() {
      try {
        await opts.render(ctx);
      } catch (e) {
        ctx.body.innerHTML = `<p class="pc-err">${esc((e as Error).message)}</p>`;
      }
      renderPrimary();
    },
    setPrimary(p) {
      primary = p;
      armed = false;
      renderPrimary();
    },
    tellClaude(text) {
      void bridge.updateModelContext(text).catch(() => {});
    },
  };

  function renderPrimary(): void {
    const act = $("pc-act");
    $("pc-note").textContent = primary?.runsOn === "mac" ? "Runs on your Mac when it's awake" : "";
    if (!primary) {
      act.innerHTML = "";
      return;
    }
    const params = primary.params ? primary.params(ctx) : {};
    if (armed) {
      const copy = primary.confirmText ?? `This will ${primary.label.toLowerCase()} outside Papr.`;
      act.innerHTML = `<span class="pc-confirm">${esc(copy)}</span><button class="pc-btn pc-ghost" id="pc-cancel">Cancel</button><button class="pc-btn" id="pc-go">Approve</button>`;
      $("pc-cancel").onclick = () => ctx.setPrimary(primary);
    } else {
      act.innerHTML = `<button class="pc-btn" id="pc-go">${esc(primary.label)}</button>`;
    }
    const go = $("pc-go") as HTMLButtonElement;
    go.disabled = params === null;
    go.onclick = () => void onPrimary(params ?? {});
  }

  async function onPrimary(params: Record<string, string>): Promise<void> {
    if (!primary) return;
    if (primary.effect === "external" && !armed) {
      armed = true;
      renderPrimary();
      return;
    }
    const p = primary;
    const go = $("pc-go") as HTMLButtonElement;
    go.disabled = true;
    go.textContent = "Working…";
    try {
      const result = await ctx.run(p.action, params);
      armed = false;
      ctx.tellClaude(`${p.label}: done in ${ctx.app.title ?? ctx.app.slug}.`);
      if (opts.onResult) await opts.onResult(result, ctx);
      await ctx.refresh();
    } catch (e) {
      armed = false;
      renderPrimary();
      $("pc-note").textContent = (e as Error).message;
    }
  }

  // Primary params usually read form fields: re-check them as the user types.
  ctx.body.addEventListener("input", () => renderPrimary());

  bridge.onHostContext = (h) => (ctx.theme = applyTheme(doc, h));
  bridge.onToolResult = (r) => {
    const sc = (r.structuredContent ?? {}) as Partial<CardAppInfo>;
    if (!sc.namespaceId || !sc.slug) {
      ctx.body.innerHTML = `<p class="pc-err">${esc(r.content?.[0]?.text ?? "This Papr app couldn't be opened.")}</p>`;
      return;
    }
    ctx.app = sc as CardAppInfo;
    ctx.data = sc.data ?? {};
    resolveRef({ namespaceId: sc.namespaceId, slug: sc.slug });
    const title = sc.title ?? sc.slug;
    $("pc-tile").textContent = initials(title);
    $("pc-title").textContent = title;
    $("pc-pub").textContent = sc.publisher ? `by ${sc.publisher}` : "Papr app";
    const open = $("pc-open") as HTMLButtonElement;
    open.disabled = !sc.openUrl;
    open.onclick = () => sc.openUrl && void bridge.openLink(sc.openUrl).catch(() => {});
    void ctx.refresh();
  };

  ctx.theme = applyTheme(doc, await bridge.connect());
  bridge.autoResize(doc);
  return ctx;
}
