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
 * The kit owns the frame so every card looks like Papr and stays safe by default
 * (the Prototyper "app card in chat" design):
 *   - header: squircle app tile, app name, one quiet meta line (ctx.setMeta)
 *   - footer: at most one primary action + "Open in {App}"
 *   - effect: 'external' → the primary asks for approval before it runs
 *   - runsOn: 'mac'      → says so, since it runs when the user's Mac is awake
 *   - Claude's theme (light/dark + host CSS variables) applied automatically
 * fetch('/api/*') and job events are rerouted through papr_api (papr-mcp-transport).
 */

import { McpHostBridge, windowPort, type BridgePort, type HostContext, type ToolResult } from "./papr-mcp-bridge.ts";
import { installMcpTransport, tunnelRequest, type AppRef } from "./papr-mcp-transport.ts";
import { CARD_CSS, frameHtml } from "./papr-card-style.ts";

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
  /** Monochrome SVG markup for the tile (optional; initials otherwise). */
  icon?: string;
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
  /** Quiet state line on the left of the footer (e.g. "Running on your Mac · synced 2 min ago"). */
  setMeta: (text: string) => void;
  /** Change the footer's "Open in Papr": land on a view, run something first (e.g. record where to land), or hide it. */
  setOpen: (open: CardOpen) => void;
  /** Hand the user to Papr on their Mac, signed in, on this app (one-time link); falls back to the web app. True when a link opened. */
  openInPapr: (opts?: { view?: string }) => Promise<boolean>;
  /** Open a link through the host (the only way out of the sandbox). */
  open: (url: string) => void;
  /** Call a Papr MCP tool through the host, e.g. papr_continue_on_mac for the "Open in Papr" hand-off. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  tellClaude: (text: string) => void;
}

/** The footer's "Open in Papr" (Prototyper: outlined pill next to the action, solid when the card has no action). */
export interface CardOpen {
  label?: string;
  /** Passed to papr_continue_on_mac so Papr lands on it, e.g. "outreach:c_123". */
  view?: string;
  /** Runs before the hand-off link is requested. */
  before?: () => void | Promise<void>;
  hidden?: boolean;
  /** Quiet text link instead of a pill (e.g. "Didn't open? Open Papr" while a hand-off is in flight). */
  quiet?: boolean;
}

/** MCP tool that mints the one-time papr:// link (server.ts). */
export const HANDOFF_TOOL = "papr_continue_on_mac";

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
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "P")[0]).toUpperCase();
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

/** Stable per-app hue so each app's tile has its own colour (like the Prototyper tiles). */
export function tintFor(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${[214, 248, 268, 192, 160, 12, 330][h % 7]} 82% 48%)`;
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
  let meta = "";
  let openCfg: CardOpen = {};
  let ready = false;
  // Footer left: the card's state line (setMeta), plus where the primary action runs.
  const renderNote = (): void => {
    $("pc-note").textContent = [meta, primary?.runsOn === "mac" ? "Runs on your Mac when it's awake" : ""].filter(Boolean).join(" · ");
  };
  /** Prototyper footer: state line left; "Open in Papr" outlined beside the one gradient action (solid when it is the only action). */
  const renderFooter = (): void => {
    renderNote();
    const open = $("pc-open") as HTMLButtonElement;
    const hidden = !!openCfg.hidden || !ready;
    open.hidden = hidden;
    open.classList.toggle("pc-solid", !primary && !openCfg.quiet);
    open.classList.toggle("pc-quiet", !!openCfg.quiet);
    if (!open.dataset.busy) open.textContent = openCfg.label ?? "Open in Papr";
    $("pc-f").classList.toggle("pc-f-off", hidden && !primary && !$("pc-note").textContent);
  };
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
    setMeta(text) {
      meta = text;
      renderFooter();
    },
    setOpen(o) {
      openCfg = o;
      renderFooter();
    },
    async openInPapr(o = {}) {
      const { namespaceId, slug, openUrl } = ctx.app;
      try {
        const res = await callTool(HANDOFF_TOOL, { namespaceId, slug, ...(o.view ? { view: o.view } : {}) });
        const url = (res.structuredContent as { url?: string } | undefined)?.url;
        if (!res.isError && url) {
          await bridge.openLink(url);
          return true;
        }
      } catch {
        /* no hand-off on this connector: fall back to the web app */
      }
      if (!openUrl) return false;
      await bridge.openLink(openUrl).catch(() => {});
      return true;
    },
    open(url) {
      void bridge.openLink(url).catch(() => {});
    },
    callTool,
  };

  async function onOpen(): Promise<void> {
    const btn = $("pc-open") as HTMLButtonElement;
    btn.disabled = true;
    btn.dataset.busy = "1";
    btn.textContent = "Opening Papr…";
    let ok = false;
    try {
      await openCfg.before?.();
      ok = await ctx.openInPapr({ view: openCfg.view });
    } catch {
      ok = false;
    }
    btn.textContent = ok ? "Opened in Papr" : "Couldn't open. Try again";
    btn.disabled = false;
    delete btn.dataset.busy;
    if (ok) ctx.tellClaude(`The user opened ${ctx.app.title ?? ctx.app.slug} in Papr on their Mac.`);
  }
  ($("pc-open") as HTMLButtonElement).onclick = () => void onOpen();

  function renderPrimary(): void {
    const act = $("pc-act");
    renderFooter();
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
      return;
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
    const tile = $("pc-tile");
    if (sc.icon && /^\s*<svg[\s>]/i.test(sc.icon)) {
      tile.innerHTML = `<img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(/<svg\b[^>]*\bxmlns\s*=/i.test(sc.icon) ? sc.icon : sc.icon.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"'))}">`;
    } else tile.textContent = initials(title);
    $("pc-title").textContent = title;
    $("pc-sub").textContent = sc.publisher ? `by ${sc.publisher}` : "Your Papr app";
    ready = true;
    renderFooter();
    void ctx.refresh();
  };

  ctx.theme = applyTheme(doc, await bridge.connect());
  bridge.autoResize(doc);
  return ctx;
}
