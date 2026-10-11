/**
 * PR 0 spike card: one self-contained HTML file rendered by Claude as an MCP App.
 *
 * It proves the three things the architecture depends on:
 *   1. Claude renders our ui:// resource (handshake via @modelcontextprotocol/ext-apps App).
 *   2. A card can make a normal app call through the hidden papr_api tool
 *      (here: list the app's tables via /api/db/query on the user's Turso DB).
 *   3. Host theme + "Open in Papr" (ui/open-link) work.
 *
 * PR 1 replaces this with the card kit + transport shim built per app at publish.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let appBundle: string | null = null;

/**
 * ext-apps ships a dependency-free ESM build ending in `export{a as App,...}`.
 * Rewrite that export list into a global so the whole card can be one inline module
 * (no external script → no CSP resourceDomains needed in the spike).
 */
export function inlineExtAppsBundle(src: string): string {
  const m = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(src);
  if (!m) throw new Error("ext-apps bundle: export list not found");
  const pairs = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [local, exported] = s.split(/\s+as\s+/);
      return `${JSON.stringify(exported ?? local)}:${local}`;
    });
  return `${src.slice(0, m.index)}\nglobalThis.McpApps={${pairs.join(",")}};\n`;
}

function extAppsBundle(): string {
  if (appBundle === null) {
    const path = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
    appBundle = inlineExtAppsBundle(readFileSync(path, "utf8"));
  }
  return appBundle;
}

const CARD_JS = String.raw`
const { App } = globalThis.McpApps;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const app = new App({ name: "Papr card", version: "0.0.1" });
let ref = null;

function theme(ctx) {
  const vars = ctx?.styles?.variables ?? {};
  for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v);
  document.documentElement.dataset.theme = ctx?.theme ?? "light";
}

/** The transport the platform SDK will install: fetch('/api/*') -> papr_api. */
async function paprApi(method, path, body) {
  const r = await app.callServerTool({ name: "papr_api", arguments: { ...ref, method, path, body } });
  const out = r.structuredContent ?? {};
  if (r.isError || out.status >= 400) throw new Error(out.body?.error ?? r.content?.[0]?.text ?? "Request failed");
  return out.body;
}

async function load() {
  $("state").textContent = "Reading your data through Papr…";
  const t0 = performance.now();
  try {
    const res = await paprApi("POST", "/api/db/query", {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
    });
    const ms = Math.round(performance.now() - t0);
    const rows = res?.rows ?? [];
    $("state").textContent = rows.length + " tables · round trip " + ms + " ms";
    $("list").innerHTML = rows.map((r) => "<li>" + esc(r.name) + "</li>").join("") || "<li class=m>No tables yet</li>";
    app.updateModelContext?.({ content: [{ type: "text", text: "Papr card loaded " + rows.length + " tables from " + ref.slug + "." }] }).catch(() => {});
  } catch (e) {
    $("state").textContent = "Couldn't read data: " + e.message;
  }
}

app.ontoolresult = (p) => {
  const sc = p.structuredContent ?? {};
  ref = { namespaceId: sc.namespaceId, slug: sc.slug };
  $("name").textContent = sc.title ?? sc.slug;
  $("who").textContent = sc.email ? "Signed in as " + sc.email : "Signed in to Papr";
  $("open").onclick = () => app.openLink({ url: sc.openUrl });
  $("open").disabled = false;
  load();
};
app.onhostcontextchanged = (ctx) => theme(ctx);
await app.connect();
theme(app.getHostContext());
`;

const CARD_CSS = `
:root{color-scheme:light dark;--fg:var(--color-text-primary,#14161a);--mu:var(--color-text-secondary,#5b6475);
--bd:var(--color-border-primary,rgba(15,23,42,.1));--bg:var(--color-background-primary,transparent);--ac:#0161E0}
[data-theme=dark]{--fg:var(--color-text-primary,rgba(255,255,255,.92));--mu:var(--color-text-secondary,rgba(255,255,255,.6));--bd:var(--color-border-primary,rgba(255,255,255,.1))}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 var(--font-sans,-apple-system,system-ui,sans-serif);color:var(--fg);background:var(--bg)}
.c{border:1px solid var(--bd);border-radius:16px;overflow:hidden}
.h{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--bd)}
.h b{display:block;font-size:13.5px}.h em{font-style:normal;font-size:11.5px;color:var(--mu)}
.by{margin-left:auto;font-size:11.5px;color:var(--mu)}.by b{display:inline;background:linear-gradient(135deg,#00C6FF,#0161E0);-webkit-background-clip:text;background-clip:text;color:transparent}
.b{padding:14px}#state{margin:0 0 8px;color:var(--mu);font-size:13px}ul{margin:0;padding-left:18px}.m{color:var(--mu)}
.f{display:flex;padding:10px 14px;border-top:1px solid var(--bd)}
button{margin-left:auto;height:36px;padding:0 16px;border:0;border-radius:999px;color:#fff;font:600 13.5px inherit;background:linear-gradient(135deg,#0161E0,#4f46e5);cursor:pointer}
button:disabled{opacity:.5}`;

export function renderSpikeCardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CARD_CSS}</style></head><body>
<div class="c"><div class="h"><div><b id="name">Papr</b><em id="who">Connecting…</em></div><span class="by">Built on <b>Papr</b></span></div>
<div class="b"><p id="state">Waiting for Claude…</p><ul id="list"></ul></div>
<div class="f"><button id="open" disabled>Open in Papr</button></div></div>
<script type="module">${extAppsBundle()}
${CARD_JS}</script></body></html>`;
}
