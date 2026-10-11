/**
 * Generic app card (papr_open_app): one self-contained HTML file rendered by Claude as an
 * MCP App, for apps whose own card tools aren't loaded. Same look as the card kit.
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
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const app = new App({ name: "Papr card", version: "0.1.0" });
const HUES = [214, 248, 268, 192, 160, 12, 330];
const tint = (k) => { let h = 0; for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0; return "hsl(" + HUES[h % 7] + " 82% 48%)"; };
const initials = (t) => { const w = t.replace(/[-_]+/g, " ").trim().split(/\s+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || "P").slice(0, 2)).toUpperCase(); };

function theme(ctx) {
  const vars = ctx?.styles?.variables ?? {};
  for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v);
  document.documentElement.dataset.theme = ctx?.theme ?? "light";
}

app.ontoolresult = (p) => {
  const sc = p.structuredContent ?? {};
  if (!sc.slug) { $("body").innerHTML = '<p class="err">' + esc(p.content?.[0]?.text ?? "This Papr app couldn't be opened.") + "</p>"; return; }
  const title = sc.title || sc.slug;
  const tile = $("tile");
  tile.style.setProperty("--tint", tint(sc.slug));
  if (sc.icon && /^\s*<svg[\s>]/i.test(sc.icon)) tile.innerHTML = '<img alt="" src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sc.icon) + '">';
  else tile.textContent = initials(title);
  $("name").textContent = title;
  $("meta").textContent = sc.publisher ? "by " + sc.publisher : "Papr app";
  const asks = (sc.examples || []).slice(0, 3);
  $("body").innerHTML = '<p class="flag">' + (sc.summary ? "<b>" + esc(title) + ".</b> " + esc(sc.summary) : "<b>" + esc(title) + "</b> is ready in Papr.") + "</p>"
    + (asks.length ? '<div class="chips"><small>Try asking</small>' + asks.map((a, i) => '<button class="chip" data-i="' + i + '">' + esc(a) + "</button>").join("") + "</div>" : "");
  document.querySelectorAll(".chip").forEach((b) => b.onclick = () => {
    const text = asks[Number(b.dataset.i)];
    if (app.sendMessage) app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch(() => {});
  });
  const open = $("open");
  open.textContent = "Open in " + title;
  open.disabled = !sc.openUrl;
  open.onclick = () => app.openLink({ url: sc.openUrl });
};
app.onhostcontextchanged = (ctx) => theme(ctx);
await app.connect();
theme(app.getHostContext());
`;

/** Same frame as the card kit (papr-card-style.ts): the Prototyper "app card in chat". */
const CARD_CSS = `
:root{color-scheme:light dark;--fg:var(--color-text-primary,#14161a);--mu:var(--color-text-secondary,#6b7280);
--bd:var(--color-border-primary,rgba(15,23,42,.09));--bg:var(--color-background-primary,#fff);--soft:var(--color-background-secondary,rgba(15,23,42,.04));
--ac:#0161E0;--tint:#0161E0;--sh:0 1px 2px rgba(15,23,42,.04),0 8px 24px rgba(15,23,42,.06)}
[data-theme=dark]{--fg:var(--color-text-primary,rgba(255,255,255,.92));--mu:var(--color-text-secondary,rgba(255,255,255,.58));
--bd:var(--color-border-primary,rgba(255,255,255,.1));--bg:var(--color-background-primary,#1c1d21);--soft:var(--color-background-secondary,rgba(255,255,255,.06));
--ac:#3b8bff;--sh:0 1px 2px rgba(0,0,0,.3)}
*{box-sizing:border-box}body{margin:0;padding:2px;font:14px/1.5 var(--font-sans,-apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif);color:var(--fg);background:transparent;-webkit-font-smoothing:antialiased}
.c{border:1px solid var(--bd);border-radius:18px;overflow:hidden;background:var(--bg);box-shadow:var(--sh);max-width:560px}
.h{display:flex;align-items:center;gap:10px;padding:10px 12px}
.tile{position:relative;overflow:hidden;width:30px;height:30px;flex:none;border-radius:23%;display:grid;place-items:center;color:#fff;font:700 11.5px/1 inherit;
background:linear-gradient(150deg,color-mix(in srgb,var(--tint) 45%,#0b0b24) 0%,var(--tint) 58%,color-mix(in srgb,var(--tint) 72%,#fff) 100%);
box-shadow:0 1px 2px rgba(0,0,0,.16),0 3px 10px color-mix(in srgb,var(--tint) 26%,transparent)}
.tile::after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(165deg,rgba(255,255,255,.32),rgba(255,255,255,0) 46%);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.28)}
.tile img{width:62%;height:62%;filter:brightness(0) invert(1)}
.h b{font-size:14px;font-weight:600;letter-spacing:-.01em}.h small{margin-left:auto;font-size:12px;color:var(--mu)}
.b{padding:2px 14px 12px}.flag{margin:0;font-size:13.5px;line-height:1.45;color:var(--mu)}.flag b{color:var(--fg);font-weight:600}.err{color:#d92d20;margin:0}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:center}.chips small{width:100%;font-size:11.5px;font-weight:600;color:var(--ac);letter-spacing:.02em}
.chip{border:1px solid var(--bd);background:var(--soft);color:var(--fg);border-radius:999px;padding:5px 11px;font:500 12.5px/1.3 inherit;cursor:pointer;text-align:left}
.chip:hover{border-color:var(--ac);color:var(--ac)}
.f{display:flex;justify-content:flex-end;padding:0 12px 12px}
#open{height:30px;min-width:64px;padding:0 14px;border:0;border-radius:999px;color:#fff;font:600 13px/1 inherit;background:var(--ac);cursor:pointer}
#open:hover{filter:brightness(1.08)}#open:disabled{opacity:.45}`;

export function renderSpikeCardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CARD_CSS}</style></head><body>
<div class="c"><div class="h"><span class="tile" id="tile">P</span><b id="name">Papr</b><small id="meta"></small></div>
<div class="b" id="body"><p class="flag">Loading…</p></div>
<div class="f"><button id="open" disabled>Open in Papr</button></div></div>
<script type="module">${extAppsBundle()}
${CARD_JS}</script></body></html>`;
}
