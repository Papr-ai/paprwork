/**
 * GET /open — the https page a Claude card links to for "Open in Papr".
 *
 * Claude only opens http(s) links, so the one-time papr:// link travels in the URL fragment
 * (never sent to a server, so never logged): /open#u=<papr://…>&web=<fallback app url>.
 * The page launches the desktop app, and if nothing opens in ~2s offers the button, the
 * download page and the web app. Works the same for Mac and Windows.
 *
 * Served by the service that issues the link (the MCP host), so link and page ship together.
 * The web fallback may point at the page's own origin or the public apps origin.
 */
import type { Express, Request, Response } from "express";

export const OPEN_PATH = "/open";
export const DOWNLOAD_URL = "https://papr.ai/download";

/** https wrapper for a one-time papr:// link, served from `pageBaseUrl`. `webUrl` is the fallback. */
export function openPageUrl(pageBaseUrl: string, paprUrl: string, webUrl?: string): string {
  const frag = new URLSearchParams({ u: paprUrl, ...(webUrl ? { web: webUrl } : {}) });
  return `${new URL(pageBaseUrl).origin}${OPEN_PATH}#${frag.toString()}`;
}

/** Public apps origin allowed as the web fallback (besides the page's own origin). */
export function appsWebOrigin(): string {
  return new URL(process.env.PAPR_CLOUD_APPS_PUBLIC_URL || "https://apps.papr.ai").origin;
}

const script = (webOrigin: string) => `
var WO=${JSON.stringify(webOrigin + "/")};
var q=new URLSearchParams(location.hash.slice(1));
var u=q.get("u")||"",w=q.get("web")||"";
var okU=/^papr:\\/\\/[^\\s"'<>]+$/.test(u),okW=w.indexOf(location.origin+"/")===0||w.indexOf(WO)===0;
history.replaceState(null,"",location.pathname);
var $=function(i){return document.getElementById(i)};
function fail(){
  $("t").textContent=okU?"Papr didn't open":"This link has expired";
  $("s").textContent=okU?"Open it yourself, or install Papr first.":"Go back to Claude and ask for a new one.";
  if(okU){$("open").href=u;$("open").hidden=false}
  $("dl").hidden=false;
  if(okW){$("web").href=w;$("web").hidden=false}
}
if(!okU){fail()}else{
  var timer=setTimeout(fail,2200),stop=function(){clearTimeout(timer)};
  window.addEventListener("blur",stop,{once:true});
  document.addEventListener("visibilitychange",function(){document.hidden&&stop()},{once:true});
  addEventListener("load",function(){setTimeout(function(){location.href=u},60)});
}`;

const page = (webOrigin: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Open Papr</title><style>
:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#111;color:#f3f3f3}
main{max-width:360px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 6px}p{margin:0 0 20px;opacity:.7}
a{display:block;margin:8px 0;padding:11px 16px;border-radius:999px;text-decoration:none;color:inherit;border:1px solid #444}
a.p{background:linear-gradient(135deg,#2f6df0,#4a90ff);border-color:transparent;color:#fff}[hidden]{display:none}
@media(prefers-color-scheme:light){body{background:#fafafa;color:#111}a{border-color:#ccc}}
</style></head><body><main><h1 id="t">Opening Papr…</h1><p id="s">Allow your browser to open Papr.</p>
<a id="open" class="p" hidden>Open Papr</a><a id="dl" hidden href="${DOWNLOAD_URL}">Get Papr for Mac or Windows</a>
<a id="web" hidden>Use the web version</a></main><script>${script(webOrigin)}</script></body></html>`;

export function registerOpenPage(app: Express, webOrigin: string = appsWebOrigin()): void {
  const html = page(webOrigin);
  app.get(OPEN_PATH, (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    res.type("html").send(html);
  });
}
