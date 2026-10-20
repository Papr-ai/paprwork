/**
 * apps.papr.ai homepage: the Community "Discover" catalog for anyone, signed in or not.
 *
 * Same listing the desktop Discover tab shows (public, Community-listed, published apps),
 * fetched from memory with the host key and server-rendered so it is fast, crawlable and
 * shareable. Look follows the desktop: featured banner, category pills, App Store cards.
 */
import { escapeHtmlAttribute as esc } from "../../../core/utils/cloudAppPreview.js";
import { getCloudAppHostKey, runtimeFetch } from "./memoryRuntimeClient.js";

export interface DiscoverEntry {
  namespaceId: string;
  slug: string;
  shareUrl: string;
  codeAccess?: string;
  name?: string | null;
  description?: string | null;
  author?: string | null;
  tags?: string[] | null;
  catalogCategory?: string | null;
  catalogHeadline?: string | null;
  catalogMedia?: Array<{ kind?: string; role?: string; url?: string | null; posterUrl?: string | null }> | null;
  installCount?: number | null;
}

const DOWNLOAD_URL = "https://papr.ai/download";
const CACHE_MS = 5 * 60_000;
let cache: { at: number; apps: DiscoverEntry[] } | null = null;

/** Public Community listing; [] when memory is unreachable (page still renders). */
export async function fetchDiscoverEntries(): Promise<DiscoverEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.apps;
  const base = (process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai").replace(/\/$/, "");
  try {
    const res = await runtimeFetch(
      `${base}/v1/cloud/apps/runtime/community`,
      { headers: { "X-Cloud-App-Host-Key": getCloudAppHostKey() } },
      15_000,
    );
    if (!res.ok) throw new Error(`memory ${res.status}`);
    const data = (await res.json()) as { apps?: DiscoverEntry[] };
    const apps = Array.isArray(data.apps) ? data.apps.filter((a) => a?.slug && a.namespaceId && a.name) : [];
    cache = { at: Date.now(), apps };
    return apps;
  } catch (err) {
    console.warn("[CloudAppHost] Discover catalog unavailable:", (err as Error).message);
    return cache?.apps ?? [];
  }
}

export function sortDiscoverEntries(apps: DiscoverEntry[]): DiscoverEntry[] {
  return [...apps].sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0) || String(a.name).localeCompare(String(b.name)));
}

/** Publisher headline first, then most installs (same rule as the desktop banner). */
export function pickFeatured(apps: DiscoverEntry[]): DiscoverEntry | null {
  if (apps.length < 4) return null;
  const score = (e: DiscoverEntry) => (e.catalogHeadline?.trim() ? 1e9 : 0) + (e.installCount ?? 0);
  return apps.reduce((best, e) => (score(e) > score(best) ? e : best), apps[0]!);
}

function coverOf(e: DiscoverEntry): string | null {
  const cover = e.catalogMedia?.find((m) => m?.role === "cover");
  const url = cover?.kind === "video" ? cover.posterUrl : cover?.url;
  return url && /^https:\/\//.test(url) ? url : null;
}

const iconUrl = (e: DiscoverEntry) => `/${encodeURIComponent(e.namespaceId)}/${encodeURIComponent(e.slug)}/opengraph-icon`;
const appUrl = (e: DiscoverEntry) => `/${encodeURIComponent(e.namespaceId)}/${encodeURIComponent(e.slug)}/`;
const byline = (e: DiscoverEntry) => (e.author ? `by ${e.author}` : "Papr Work community");

function card(e: DiscoverEntry): string {
  const cover = coverOf(e);
  const name = esc(e.name ?? e.slug);
  const banner = cover
    ? `<img class="cv" src="${esc(cover)}" alt="" loading="lazy" onerror="this.remove()">`
    : `<span class="cv cv--def"><span>${name}</span></span>`;
  return `<a class="card" href="${appUrl(e)}" data-cat="${esc(e.catalogCategory ?? "Other")}">
  <span class="ban">${banner}</span>
  <span class="row"><img class="ic" src="${iconUrl(e)}" alt="" loading="lazy" width="44" height="44">
    <span class="tx"><b>${name}</b><small>${esc(byline(e))}</small></span><span class="btn">Open</span></span>
  <span class="ds">${esc(e.description ?? "")}</span></a>`;
}

export function buildDiscoverHtml(input: { apps: DiscoverEntry[]; publicBaseUrl: string }): string {
  const apps = sortDiscoverEntries(input.apps);
  const featured = pickFeatured(apps);
  const cats = [...new Set(apps.map((a) => a.catalogCategory || "Other"))].sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)));
  const pills = apps.length >= 6 && cats.length >= 2
    ? `<nav class="pills"><button class="on" data-c="">All</button>${cats.map((c) => `<button data-c="${esc(c)}">${esc(c)}</button>`).join("")}</nav>`
    : "";
  const feat = featured
    ? `<a class="feat" href="${appUrl(featured)}">${coverOf(featured) ? `<img src="${esc(coverOf(featured)!)}" alt="" onerror="this.remove()">` : ""}
  <span class="ft"><span class="k">Featured</span><span class="h">${esc(featured.catalogHeadline?.trim() || featured.description || featured.name || "")}</span>
  <span class="fa"><img class="ic" src="${iconUrl(featured)}" alt="" width="52" height="52"><span class="tx"><b>${esc(featured.name ?? "")}</b><small>${esc(byline(featured))}</small></span><span class="btn btn--w">Open</span></span></span></a>`
    : "";
  const grid = apps.length
    ? `<section class="grid">${apps.map(card).join("")}</section>`
    : `<p class="empty">No community apps to show right now. <a href="${DOWNLOAD_URL}">Get Papr Work</a> to build and publish your own.</p>`;
  const title = "Discover apps · Papr Work";
  const desc = "Apps built and shared by the Papr Work community. Open any app in your browser, or get Papr Work to make it your own.";
  const base = input.publicBaseUrl.replace(/\/$/, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(base)}/">
<meta property="og:title" content="${title}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(base)}/"><meta property="og:site_name" content="Papr Work">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0b0c10" media="(prefers-color-scheme: dark)">
<style>${DISCOVER_CSS}</style></head><body>
<header><a class="brand" href="/">Papr Work</a><a class="get" href="${DOWNLOAD_URL}">Get Papr Work</a></header>
<main><h1>Discover</h1><p class="sub">Apps built and shared by the Papr Work community.</p>
${feat}${pills}${grid}</main>
<script>document.querySelectorAll('.pills button').forEach(function(b){b.onclick=function(){document.querySelectorAll('.pills button').forEach(function(x){x.classList.toggle('on',x===b)});var c=b.dataset.c;document.querySelectorAll('.card').forEach(function(k){k.hidden=!!c&&k.dataset.cat!==c})}})</script>
</body></html>`;
}

const DISCOVER_CSS = `
:root{--bg:#f5f5f7;--card:#fff;--tx:#1d1d1f;--mu:#6e6e73;--line:rgba(10,16,32,.07);--acc:#0060e0;--chip:rgba(0,0,0,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0c10;--card:#16171c;--tx:#f5f5f7;--mu:#a1a1a6;--line:rgba(255,255,255,.08);--acc:#3b8bff;--chip:rgba(255,255,255,.09)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Inter",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;padding:14px clamp(16px,4vw,40px);background:color-mix(in srgb,var(--bg) 78%,transparent);backdrop-filter:blur(20px) saturate(1.6);border-bottom:.5px solid var(--line)}
.brand{font-weight:700;letter-spacing:-.01em}.get{height:32px;display:inline-flex;align-items:center;padding:0 16px;border-radius:999px;background:var(--acc);color:#fff;font-weight:650;font-size:14px}
main{max-width:1180px;margin:0 auto;padding:28px clamp(16px,4vw,40px) 64px}
h1{margin:0;font-size:clamp(30px,4vw,40px);letter-spacing:-.03em}.sub{margin:4px 0 22px;color:var(--mu)}
.feat{position:relative;display:block;height:clamp(260px,32vw,380px);border-radius:26px;overflow:hidden;color:#fff;margin-bottom:26px;
 background:radial-gradient(80% 110% at 88% 0%,color-mix(in srgb,var(--acc) 70%,transparent),transparent 62%),linear-gradient(150deg,color-mix(in srgb,var(--acc) 42%,#06061a),color-mix(in srgb,var(--acc) 80%,#000));box-shadow:0 18px 50px rgba(0,0,0,.22)}
.feat>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top center}
.ft{position:absolute;inset:auto 0 0;display:grid;gap:14px;padding:90px 28px 20px;background:linear-gradient(transparent,rgba(0,0,0,.4) 38%,rgba(0,0,0,.82))}
.k{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;opacity:.88}
.h{max-width:560px;font-size:clamp(22px,3vw,34px);line-height:1.1;font-weight:700;letter-spacing:-.025em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.fa{display:flex;align-items:center;gap:12px;max-width:520px;padding:10px 12px;border-radius:18px;background:rgba(16,16,22,.46);border:.5px solid rgba(255,255,255,.16);backdrop-filter:blur(28px) saturate(1.6)}
.fa small{color:rgba(255,255,255,.84)}
.pills{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 20px}.pills button{height:30px;padding:0 14px;border:0;border-radius:15px;background:var(--chip);color:var(--tx);font:inherit;font-size:13.5px;font-weight:550;cursor:pointer}
.pills button.on{background:var(--tx);color:var(--bg)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:28px 22px}
.card{display:flex;flex-direction:column;gap:12px;min-width:0}.card[hidden]{display:none}
.ban{position:relative;display:block;aspect-ratio:16/10;border-radius:20px;overflow:hidden;background:var(--card);box-shadow:0 0 0 1px var(--line);transition:transform .2s,box-shadow .2s}
.card:hover .ban{transform:translateY(-2px);box-shadow:0 0 0 1px var(--line),0 14px 36px rgba(10,16,32,.12)}
.cv{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top center}
.cv--def{display:grid;place-items:center;padding:20px;text-align:center;color:#fff;font-size:22px;font-weight:700;letter-spacing:-.02em;background:linear-gradient(135deg,#0060e0,#00acfa)}
.row{display:flex;align-items:center;gap:12px;min-width:0}.ic{flex:none;border-radius:50%;background:#fff}
.tx{flex:1;min-width:0;display:grid;gap:2px}.tx b{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tx small{font-size:12.5px;color:var(--mu);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{flex:none;height:30px;display:inline-flex;align-items:center;padding:0 16px;border-radius:999px;background:var(--chip);color:var(--acc);font-size:13.5px;font-weight:650}
.btn--w{background:#fff;color:#0060e0}
.ds{font-size:13.5px;color:var(--mu);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.empty{color:var(--mu)}.empty a{color:var(--acc)}
@media (max-width:640px){.feat{height:auto;aspect-ratio:4/5}.grid{grid-template-columns:1fr}}
`;
