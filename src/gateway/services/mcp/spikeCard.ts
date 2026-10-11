/**
 * The papr_open_app card. Two jobs:
 *
 *   1. The app has its own published card (dist/cards/{view}.html): show THAT card, so an app
 *      looks the same whether Claude reached it through its own tool or through papr_open_app.
 *      The app card runs in a nested frame; this page is its host. It answers ui/initialize
 *      itself, hands over the app's tool result, and relays every other request to Claude.
 *   2. No card: the Prototyper "Claude × Papr" frame (papr-card-style.ts) with the app's summary,
 *      a few things to ask, and "Open in {App}".
 *
 * Plain JSON-RPC over postMessage (MCP Apps), no SDK: this page must own the host session to relay it.
 */
import { CARD_CSS, frameHtml } from "../../../resources/mini-app-sdk/papr-card-style.js";

const PROTOCOL = "2026-01-26";

/** Kept for the ext-apps inline-bundle test; app cards are built by cardBuild. */
export function inlineExtAppsBundle(src: string): string {
  const m = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(src);
  if (!m) throw new Error("ext-apps bundle: export list not found");
  const pairs = m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [local, exported] = s.split(/\s+as\s+/);
    return `${JSON.stringify(exported ?? local)}:${local}`;
  });
  return `${src.slice(0, m.index)}\nglobalThis.McpApps={${pairs.join(",")}};\n`;
}

const CARD_JS = String.raw`
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const host = window.parent;
let seq = 1, ctx = {}, nest = null;
const pending = new Map();
const send = (m) => host.postMessage({ jsonrpc: "2.0", ...m }, "*");
const request = (method, params) => new Promise((ok, no) => { const id = "c" + seq++; pending.set(id, { ok, no }); send({ id, method, params }); });

function theme(c) {
  ctx = { ...ctx, ...(c || {}) };
  document.documentElement.dataset.theme = ctx.theme === "dark" ? "dark" : "light";
  if (ctx.styles?.variables?.["--font-sans"]) document.documentElement.style.setProperty("--font-sans", ctx.styles.variables["--font-sans"]);
}
function size() {
  const el = document.documentElement;
  send({ method: "ui/notifications/size-changed", params: { width: Math.ceil(el.scrollWidth), height: Math.ceil(el.scrollHeight) } });
}

/** Generic frame: summary, things to ask, Open in {App}. */
function generic(sc, text) {
  if (!sc.slug) { $("pc-body").innerHTML = '<p class="pc-err">' + esc(text || "This Papr app couldn't be opened.") + "</p>"; return; }
  const title = sc.title || sc.slug;
  if (sc.icon && /^\s*<svg[\s>]/i.test(sc.icon)) $("pc-tile").innerHTML = '<img alt="" src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sc.icon) + '">';
  else $("pc-tile").textContent = title.trim().slice(0, 1).toUpperCase();
  $("pc-title").textContent = title;
  $("pc-sub").textContent = sc.publisher ? "by " + sc.publisher : "Your Papr app";
  const asks = (sc.examples || []).slice(0, 3);
  $("pc-body").innerHTML = '<p class="pc-flag"><b>' + esc(title) + ".</b> " + esc(sc.summary || "Ready in Papr.") + "</p>"
    + (asks.length ? '<div class="pc-chips"><small>Try asking</small>' + asks.map((a, i) => '<button class="pc-chip" data-i="' + i + '">' + esc(a) + "</button>").join("") + "</div>" : "");
  document.querySelectorAll(".pc-chip").forEach((b) => b.onclick = () => request("ui/message", { role: "user", content: [{ type: "text", text: asks[Number(b.dataset.i)] }] }).catch(() => {}));
  const open = $("pc-open");
  open.textContent = "Open in " + title;
  open.disabled = !sc.openUrl;
  open.onclick = () => request("ui/open-link", { url: sc.openUrl }).catch(() => {});
}

/** The app's own card, hosted here. Falls back to the generic frame if it doesn't start. */
async function nested(sc, text) {
  let html = "";
  try { html = (await request("tools/call", { name: "papr_card_html", arguments: { namespaceId: sc.namespaceId, slug: sc.slug, view: sc.card.view } }))?.structuredContent?.html || ""; } catch {}
  if (!html) return generic(sc, text);
  const f = document.createElement("iframe");
  f.className = "pc-nest"; f.title = sc.title || sc.slug; f.style.height = "0px";
  const toNest = (m) => f.contentWindow && f.contentWindow.postMessage({ jsonrpc: "2.0", ...m }, "*");
  const result = { content: [{ type: "text", text: text || "" }], structuredContent: sc.card.result };
  let started = false;
  nest = { frame: f, toNest };
  window.addEventListener("message", async (e) => {
    if (e.source !== f.contentWindow) return;
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0" || !m.method) return;
    const reply = (r, err) => m.id !== undefined && toNest(err ? { id: m.id, error: { code: -32000, message: String(err) } } : { id: m.id, result: r ?? {} });
    switch (m.method) {
      case "ui/initialize": started = true; reply({ protocolVersion: m.params?.protocolVersion || "${PROTOCOL}", hostInfo: { name: "papr", version: "1" }, hostCapabilities: { openLinks: {}, serverTools: {} }, hostContext: ctx }); return;
      case "ui/notifications/initialized": toNest({ method: "ui/notifications/tool-input", params: { arguments: {} } }); toNest({ method: "ui/notifications/tool-result", params: result }); return;
      case "ui/notifications/size-changed": f.style.height = Math.ceil(m.params?.height || 0) + "px"; size(); return;
      default:
        if (m.id === undefined) { send({ method: m.method, params: m.params }); return; }
        try { reply(await request(m.method, m.params)); } catch (err) { reply(null, err?.message || err); }
    }
  });
  document.body.classList.add("is-nested");
  f.srcdoc = html;
  document.body.appendChild(f);
  setTimeout(() => { if (!started) { f.remove(); nest = null; document.body.classList.remove("is-nested"); generic(sc, text); size(); } }, 6000);
}

window.addEventListener("message", (e) => {
  if (e.source !== host) return;
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id !== undefined && !m.method) {
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    m.error ? p.no(new Error(m.error.message)) : p.ok(m.result ?? {});
    return;
  }
  const params = m.params ?? {};
  if (m.method === "ui/notifications/tool-result") {
    const sc = params.structuredContent ?? {}, text = params.content?.[0]?.text;
    sc.card?.view && sc.card?.result ? nested(sc, text) : generic(sc, text);
  } else if (m.method === "ui/notifications/host-context-changed") {
    theme(params);
    nest?.toNest({ method: m.method, params });
  } else if (m.method === "ui/resource-teardown") nest?.toNest({ id: "t" + seq++, method: m.method, params });
  if (m.id !== undefined && m.method) send({ id: m.id, result: {} });
});

new ResizeObserver(size).observe(document.documentElement);
request("ui/initialize", { appInfo: { name: "papr-open-app", version: "2.0.0" }, appCapabilities: {}, protocolVersion: "${PROTOCOL}" })
  .then((r) => { theme(r.hostContext); send({ method: "ui/notifications/initialized", params: {} }); })
  .catch(() => {});
`;

export function renderSpikeCardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CARD_CSS}
body.is-nested{padding:0}body.is-nested>.pc{display:none}</style></head><body>
${frameHtml()}
<script type="module">${CARD_JS}</script></body></html>`;
}
