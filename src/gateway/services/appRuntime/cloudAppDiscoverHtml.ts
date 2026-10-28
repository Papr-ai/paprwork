/**
 * apps.papr.ai Discover markup — mirrors the desktop Discover tab (CommunityAppsView):
 * featured banner, category pills, App Store cards with the Papr droplet icon, and the
 * App details modal (CatalogAppDetails). Every app also has a crawlable page,
 * /discover/{ns}/{slug}, that server-renders the same modal open.
 */
import { escapeHtmlAttribute as esc } from "../../../core/utils/cloudAppPreview.js";
import type { DiscoverEntry } from "./cloudAppDiscoverPage.js";
import { DISCOVER_CSS, DISCOVER_JS } from "./cloudAppDiscoverAssets.js";

export type DiscoverView = "discover" | "mine";

const PAPR_URL = "https://papr.ai";
const DOWNLOAD_URL = "https://papr.ai/download";
const OTHER = "Other";

const seg = (s: string) => encodeURIComponent(s);
const appPath = (e: DiscoverEntry) => `/${seg(e.namespaceId)}/${seg(e.slug)}/`;
export const detailPath = (e: DiscoverEntry) => `/discover/${seg(e.namespaceId)}/${seg(e.slug)}`;
const key = (e: DiscoverEntry) => `${e.namespaceId}/${e.slug}`;
const tplId = (e: DiscoverEntry) => `d-${key(e).replace(/[^A-Za-z0-9_-]/g, "_")}`;
const name = (e: DiscoverEntry) => e.name?.trim() || e.slug;
const byline = (e: DiscoverEntry, me?: string) =>
  me && e.publisherUserId === me ? "By you" : `By ${e.author?.trim() || "Unknown"}`;
const category = (e: DiscoverEntry) => e.catalogCategory?.trim() || OTHER;
const httpsUrl = (u?: string | null) => (u && /^https:\/\/\S+$/.test(u) ? u : null);

function cover(e: DiscoverEntry): { image: string | null; video: string | null } {
  const c = e.catalogMedia?.find((m) => m?.role === "cover" && m.scheme !== "dark");
  if (!c) return { image: null, video: null };
  if (c.kind === "video") return { image: httpsUrl(c.posterUrl), video: httpsUrl(c.url) };
  return { image: httpsUrl(c.url), video: null };
}

/** Publisher SVG → <img> data URI (never inline: scripts in an <img> SVG don't run). */
function svgImg(svg: string, ink: string): string {
  let s = svg.trim().replace(/currentColor/g, ink);
  if (!/xmlns=/.test(s.slice(0, 200))) s = s.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
}

/** Same rules as the desktop DropGlyph: logo inside the Papr glass droplet. */
export function dropGlyph(e: DiscoverEntry, size: number): string {
  const icon = e.icon?.trim() ?? "";
  const box = `style="width:${size}px;height:${size}px"`;
  if (/^(data:image\/|https:\/\/)/.test(icon)) {
    return `<span class="gl gl--img" ${box}><img src="${esc(icon)}" alt="" loading="lazy"></span>`;
  }
  if (icon.startsWith("<svg")) {
    return `<span class="gl drop" ${box}><img class="ink-l" src="${esc(svgImg(icon, "rgba(55,65,88,0.78)"))}" alt="" loading="lazy"><img class="ink-d" src="${esc(svgImg(icon, "rgba(210,218,232,0.9)"))}" alt="" loading="lazy"></span>`;
  }
  if (icon && icon.length <= 4 && /\p{Extended_Pictographic}/u.test(icon)) {
    return `<span class="gl drop" ${box}><span style="font-size:${Math.round(size * 0.42)}px">${esc(icon)}</span></span>`;
  }
  const letter = (name(e)[0] ?? "?").toUpperCase();
  return `<span class="gl drop drop--l" ${box}><span style="font-size:${Math.round(size * 0.36)}px">${esc(letter)}</span></span>`;
}

function banner(e: DiscoverEntry, opts: { video?: boolean } = {}): string {
  const { image, video } = cover(e);
  if (video && image && opts.video) {
    return `<span class="ban"><video class="ban__img" src="${esc(video)}" poster="${esc(image)}" muted loop playsinline autoplay preload="metadata"></video></span>`;
  }
  if (image) {
    return `<span class="ban"><img class="ban__img" src="${esc(image)}" alt="${esc(name(e))} preview" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'dcover',innerHTML:'<b>'+this.alt.replace(/ preview$/,'').replace(/</g,'&lt;')+'</b>'}))"></span>`;
  }
  return `<span class="ban"><span class="dcover"><b>${esc(name(e))}</b></span></span>`;
}

/** Desktop rule: Preview = the live web app (unless it needs the desktop), Get = make your own copy. */
const canPreview = (e: DiscoverEntry) => e.catalogRequiresDesktop !== true;

function card(e: DiscoverEntry, me?: string): string {
  const preview = canPreview(e)
    ? `<a class="btn" href="${appPath(e)}" target="_blank" rel="noopener" title="Open the live web app">Preview</a>`
    : "";
  return `<div class="card" data-cat="${esc(category(e))}">
<a class="card__ban" href="${detailPath(e)}" data-d="${tplId(e)}" aria-label="${esc(name(e))}">${banner(e)}</a>
<span class="row"><a class="row__main" href="${detailPath(e)}" data-d="${tplId(e)}">${dropGlyph(e, 44)}<span class="tx"><b>${esc(name(e))}</b><small>${esc(byline(e, me))}</small></span></a>
<span class="row__act">${preview}<a class="btn btn--solid" href="${detailPath(e)}" data-d="${tplId(e)}" title="Get this app">Get</a></span></span></div>`;
}

function ago(iso?: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const d = Math.max(0, (Date.now() - t) / 86_400_000);
  if (d < 1) return "today";
  if (d < 30) return `${Math.floor(d)}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

const ICON = {
  key: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3 13.5 2.5M11.5 4.5l1.5 1.5M10 6l1.2 1.2" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m3.5 8.5 3 3 6-7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bolt: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" stroke-linejoin="round"/></svg>',
  globe: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z"/></svg>',
  users: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c2.1.7 3.5 2.6 3.5 5.2"/></svg>',
  info: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v3.8M8 5h.01" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m4 4 8 8M12 4l-8 8" stroke-linecap="round"/></svg>',
};

/** App details — same sections as the desktop modal. */
function details(e: DiscoverEntry, me?: string): string {
  const keys = (e.catalogRequirements ?? []).map((r) => r?.name).filter((n): n is string => Boolean(n));
  const installs = e.installCount ?? 0;
  const updated = ago(e.updatedAt);
  const facts: Array<[string, string]> = [
    ...(installs > 0 ? [[installs.toLocaleString("en-US"), installs === 1 ? "install" : "installs"] as [string, string]] : []),
    [byline(e, me).replace(/^By\s+/, "") || "Papr", "built by"],
    [String(keys.length), keys.length === 1 ? "key needed" : "keys needed"],
    ...(updated ? [[updated, "updated"] as [string, string]] : []),
    ["Web", "also runs on"],
  ];
  const shots = (e.catalogMedia ?? []).filter((m) => m?.role === "gallery" && m.scheme !== "dark" && m.kind === "image" && httpsUrl(m.url));
  return `<article class="page" itemscope itemtype="https://schema.org/SoftwareApplication">
<section class="hero"><div class="hero__media">${banner(e, { video: true })}</div>
<div class="id">${dropGlyph(e, 88)}<div class="id__t"><h1 itemprop="name">${esc(name(e))}</h1>${e.catalogHeadline?.trim() ? `<p>${esc(e.catalogHeadline.trim())}</p>` : ""}</div>
<div class="cta">${canPreview(e) ? `<a class="btn btn--lg" href="${appPath(e)}" target="_blank" rel="noopener">Preview</a>` : ""}<a class="btn btn--lg btn--solid" href="${DOWNLOAD_URL}" title="Get Papr Work to make your own copy">Get</a></div></div></section>
<ul class="facts">${facts.map(([v, k]) => `<li><b title="${esc(v)}">${esc(v)}</b><span>${esc(k)}</span></li>`).join("")}</ul>
${e.description ? `<section class="sec"><h2>About</h2><p class="desc" itemprop="description">${esc(e.description)}</p></section>` : ""}
${shots.length ? `<section class="sec"><h2>Screenshots</h2><div class="shots">${shots.map((m) => `<figure><img src="${esc(m.url!)}" alt="${esc(m.alt ?? `${name(e)} screenshot`)}" loading="lazy">${m.alt ? `<figcaption>${esc(m.alt)}</figcaption>` : ""}</figure>`).join("")}</div></section>` : ""}
<section class="sec two"><div><h2>What it needs</h2><ul class="list">${keys.length ? keys.map((k) => `<li>${ICON.key}<code>${esc(k)}</code></li>`).join("") : `<li>${ICON.check}<span>No keys needed</span></li>`}</ul></div>
<div><h2>What it runs</h2><ul class="list"><li>${ICON.bolt}<span>${esc(e.catalogAutomation?.cardLine ?? "Nothing in the background")}</span></li><li>${ICON.globe}<span>Also works on the web</span></li></ul></div></section>
<p class="note">Get Papr Work to make your own copy: your data stays private, and updates arrive automatically.</p>
<meta itemprop="applicationCategory" content="BusinessApplication"><meta itemprop="operatingSystem" content="Web, macOS, Windows"><link itemprop="url" href="${appPath(e)}">
</article>`;
}

/** The details modal. `e` = server-rendered open (detail page); none = empty shell the script fills. */
function modal(e: DiscoverEntry | undefined, me: string | undefined, closeHref: string): string {
  return `<div class="modal"${e ? "" : " hidden"} data-close="${esc(closeHref)}"><div class="modal__card" role="dialog" aria-modal="true" aria-label="${esc(e ? name(e) : "App details")}">
<a class="modal__x" href="${esc(closeHref)}" aria-label="Close">${ICON.x}</a><div class="modal__scroll" tabindex="-1">${e ? details(e, me) : ""}</div></div></div>`;
}

function featured(e: DiscoverEntry, me?: string): string {
  const { image } = cover(e);
  return `<a class="feat${image ? " has-shot" : ""}" href="${detailPath(e)}" data-d="${tplId(e)}" aria-label="Featured: ${esc(name(e))}">
${image ? `<img class="feat__shot" src="${esc(image)}" alt="" onerror="this.remove()">` : `<span class="feat__big">${dropGlyph(e, 168)}</span>`}
<span class="feat__txt"><span class="feat__k">Featured</span><span class="feat__h">${esc(e.catalogHeadline?.trim() || e.description || name(e))}</span>
<span class="feat__app">${dropGlyph(e, 52)}<span class="tx"><b>${esc(name(e))}</b><small>${esc(byline(e, me))}</small></span><span class="btn btn--w">Get</span></span></span></a>`;
}

/** Publisher headline first, then most installs (desktop pickFeaturedCatalogEntry). */
function pickFeatured(apps: DiscoverEntry[]): DiscoverEntry | null {
  if (apps.length < 4) return null;
  const score = (e: DiscoverEntry) => (e.catalogHeadline?.trim() ? 1e9 : 0) + (e.installCount ?? 0);
  return apps.reduce((best, e) => (score(e) > score(best) ? e : best), apps[0]!);
}

function pills(apps: DiscoverEntry[]): string {
  const cats = [...new Set(apps.map(category))].sort((a, b) => (a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b)));
  if (apps.length < 6 || cats.filter((c) => c !== OTHER).length < 2) return "";
  return `<nav class="pills" aria-label="Categories"><button class="on" data-c="">All</button>${cats.map((c) => `<button data-c="${esc(c)}">${esc(c)}</button>`).join("")}</nav>`;
}

const sortApps = (apps: DiscoverEntry[]) =>
  [...apps].sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0) || name(a).localeCompare(name(b)));


/** My apps — desktop AppsHome rows: droplet · name · status line · Open. No covers, no featured. */
function mineRow(e: DiscoverEntry, me?: string): string {
  const yours = Boolean(me && e.publisherUserId === me);
  const updated = ago(e.updatedAt);
  const line = [yours ? "" : `by ${e.author?.trim() || "Unknown"}`, updated ? `Updated ${updated}` : ""].filter(Boolean).join(" · ");
  const shared = !yours || (e.visibility && e.visibility !== "private");
  return `<div class="mrow" data-who="${yours ? "me" : "team"}" data-cat="${esc(category(e))}">
<a class="mrow__main" href="${appPath(e)}" target="_blank" rel="noopener" title="${esc(name(e))}">${dropGlyph(e, 48)}<span class="mrow__txt"><span class="mrow__t"><b>${esc(name(e))}</b>${shared ? `<span class="mrow__mark" title="Shared">${ICON.users}</span>` : ""}</span>${e.description ? `<span class="mrow__d">${esc(e.description)}</span>` : ""}${line ? `<span class="mrow__s">${esc(line)}</span>` : ""}</span></a>
<span class="mrow__act">${mineActions(e, yours)}</span></div>`;
}

/** Yours: Open. Someone else's: Preview (live web app) + Get when its code can be copied. */
function mineActions(e: DiscoverEntry, yours: boolean): string {
  const info = e.codeAccess === "install"
    ? `<a class="mrow__info" href="${detailPath(e)}" data-d="${tplId(e)}" aria-label="About ${esc(name(e))}">${ICON.info}</a>`
    : "";
  if (yours) return `${info}<a class="btn" href="${appPath(e)}" target="_blank" rel="noopener">Open</a>`;
  const get = e.codeAccess === "install"
    ? `<a class="btn btn--solid" href="${detailPath(e)}" data-d="${tplId(e)}" title="Get this app">Get</a>`
    : "";
  return `<a class="btn" href="${appPath(e)}" target="_blank" rel="noopener" title="Open the live web app">Preview</a>${get}`;
}

function mineBody(mine: DiscoverEntry[], me?: string): string {
  const yours = mine.filter((e) => me && e.publisherUserId === me);
  const team = mine.length - yours.length;
  const cats = [...new Set(mine.map(category))].filter((c) => c !== OTHER && mine.filter((e) => category(e) === c).length >= 2).sort();
  const chip = (f: string, label: string, on = false) => `<button class="${on ? "on" : ""}" data-f="${esc(f)}">${label}</button>`;
  const chips = yours.length && team
    ? `<nav class="chips" aria-label="Filter apps">${chip("", "All", true)}${chip("who:me", "By you")}${chip("who:team", `${ICON.users}Shared with you`)}${cats.length ? '<span class="chips__sep"></span>' : ""}${cats.map((c) => chip(`cat:${c}`, esc(c))).join("")}</nav>`
    : "";
  return `${chips}<section class="mrows">${mine.map((e) => mineRow(e, me)).join("")}</section><p class="mnone" hidden>Nothing here.</p>`;
}

const PAPR_MARK = `<svg class="logo__mark" viewBox="0 0 105 124" width="20" height="24" fill="none" aria-hidden="true"><path d="M28 101.5C-11.5 158 7 51 43.4 60.5c55.9 14.6 71.8-39.7 40.3-52.2C40.3-8.9 52 65 28 101.5Z" stroke="url(#pl)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="pl" x1="17.2" y1="89.4" x2="68.9" y2="35.8" gradientUnits="userSpaceOnUse"><stop stop-color="#0060E0"/><stop offset=".6" stop-color="#00ACFA"/><stop offset="1" stop-color="#0BCDFF"/></linearGradient></defs></svg>`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent(PAPR_MARK.replace(' class="logo__mark"', "").replace(' width="20" height="24"', ""))}`;

export interface DiscoverHtmlInput {
  view: DiscoverView;
  apps: DiscoverEntry[];
  mine: DiscoverEntry[] | null;
  focused?: DiscoverEntry;
  focusedIsPublic: boolean;
  signedIn: boolean;
  userId?: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  publicBaseUrl: string;
}

export function buildDiscoverHtml(input: DiscoverHtmlInput): string {
  const base = input.publicBaseUrl.replace(/\/$/, "");
  const me = input.userId;
  const view = input.focused && !input.focusedIsPublic ? "mine" : input.view;
  const listPath = view === "mine" ? "/my-apps" : "/";
  const apps = sortApps(input.apps);
  const mine = input.mine ? sortApps(input.mine) : null;
  const feat = view === "discover" ? pickFeatured(apps) : null;

  let body: string;
  if (view === "mine") {
    body = !mine
      ? `<section class="empty"><h2>Couldn't load your apps</h2><p>Try again in a moment.</p></section>`
      : !mine.length
        ? `<section class="empty"><h2>No apps yet</h2><p>Publish an app from Papr Work and it shows up here.</p><a class="btn btn--lg btn--solid" href="${DOWNLOAD_URL}">Get Papr Work</a></section>`
        : mineBody(mine, me);
  } else {
    body = apps.length
      ? `${feat ? featured(feat, me) : ""}${pills(apps)}<section class="grid">${apps.map((e) => card(e, me)).join("")}</section>`
      : `<section class="empty"><h2>No community apps right now</h2><p>Build and share your own with Papr Work.</p><a class="btn btn--lg btn--solid" href="${DOWNLOAD_URL}">Get Papr Work</a></section>`;
  }

  // One details template per app on screen; the focused app's modal is rendered open.
  const shown = new Map<string, DiscoverEntry>();
  for (const e of view === "mine" ? (mine ?? []).filter((m) => m.codeAccess === "install") : apps) shown.set(key(e), e);
  if (input.focused) shown.set(key(input.focused), input.focused);
  const templates = [...shown.values()].map((e) => `<template id="${tplId(e)}">${details(e, me)}</template>`).join("");
  const openModal = modal(input.focused, me, listPath);

  const f = input.focused;
  const title = f ? `${name(f)} · Papr Work apps` : view === "mine" ? "My apps · Papr Work" : "Discover apps built with Papr Work";
  const desc = f
    ? (f.catalogHeadline?.trim() || f.description?.trim() || `${name(f)}, an app built with Papr Work.`).slice(0, 300)
    : "Discover apps built and shared by the Papr Work community: AI agents, dashboards and automations you can open in your browser or make your own.";
  const canonical = f ? `${base}${detailPath(f)}` : view === "mine" ? `${base}/my-apps` : `${base}/`;
  const ogImage = f ? `${base}${appPath(f)}opengraph-image` : null;
  const noindex = view === "mine" || (f && !input.focusedIsPublic);
  const jsonLd = f && input.focusedIsPublic
    ? {
        "@context": "https://schema.org", "@type": "SoftwareApplication", name: name(f), description: desc,
        applicationCategory: "BusinessApplication", operatingSystem: "Web, macOS, Windows", url: `${base}${appPath(f)}`,
        ...(ogImage ? { image: ogImage } : {}), ...(f.author ? { author: { "@type": "Person", name: f.author } } : {}),
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      }
    : view === "discover"
      ? {
          "@context": "https://schema.org", "@type": "ItemList", name: "Papr Work community apps",
          itemListElement: apps.map((e, i) => ({ "@type": "ListItem", position: i + 1, url: `${base}${detailPath(e)}`, name: name(e) })),
        }
      : null;

  const who = input.displayName?.trim() || input.email?.trim() || "Signed in";
  const initial = esc((who[0] ?? "?").toUpperCase());
  const avatar = httpsUrl(input.avatarUrl)
    ? `<img src="${esc(input.avatarUrl!)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${initial}'}))">`
    : `<span>${initial}</span>`;
  const account = input.signedIn
    ? `<details class="acct"><summary class="acct__btn" aria-label="Account" title="${esc(who)}">${avatar}</summary>
<div class="acct__menu" role="menu"><div class="acct__who">${input.displayName?.trim() ? `<b>${esc(input.displayName.trim())}</b>` : ""}${input.email ? `<small>${esc(input.email)}</small>` : ""}</div>
<a role="menuitem" href="/my-apps">My apps</a><a role="menuitem" href="${DOWNLOAD_URL}">Get Papr Work</a><hr><a role="menuitem" href="/auth/logout?returnTo=%2F">Sign out</a></div></details>`
    : `<a class="link" href="/auth/login?returnTo=${encodeURIComponent(f ? detailPath(f) : "/")}">Sign in</a>`;
  const tab = (href: string, label: string, on: boolean) => `<a href="${href}"${on ? ' class="on" aria-current="page"' : ""}>${label}</a>`;
  const tabs = `${input.signedIn ? tab("/my-apps", "My apps", view === "mine") : ""}${tab("/", "Discover", view === "discover")}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(canonical)}"><link rel="icon" href="${FAVICON}">
${noindex ? '<meta name="robots" content="noindex">' : ""}
<meta property="og:type" content="website"><meta property="og:site_name" content="Papr Work"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(canonical)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}"><meta name="twitter:image" content="${esc(ogImage)}">` : ""}
<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}">
<meta name="theme-color" content="#f5f5f7" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0b0c10" media="(prefers-color-scheme: dark)">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
<style>${DISCOVER_CSS}</style></head><body>
<div class="nprog" aria-hidden="true"></div>
<header class="top"><a class="logo" href="${PAPR_URL}" title="Learn about Papr">${PAPR_MARK}<span>Papr</span></a>
<nav class="tabs" aria-label="Sections">${tabs}</nav>
<span class="right">${account}<a class="btn btn--solid get" href="${DOWNLOAD_URL}">Get Papr Work</a></span></header>
<main${view === "mine" ? ' class="narrow"' : ""}>${view === "mine" ? '<h1 class="mh1">My apps</h1>' : '<h1 class="h1">Discover</h1><p class="sub">Apps built and shared by the Papr Work community.</p>'}
${body}</main>
<footer class="foot"><a href="${PAPR_URL}">Papr</a> · <a href="${DOWNLOAD_URL}">Download Papr Work</a></footer>
${openModal}${templates}
<script>${DISCOVER_JS}</script></body></html>`;
}

export function buildRobotsTxt(base: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nDisallow: /my-apps\n\nSitemap: ${base.replace(/\/$/, "")}/sitemap.xml\n`;
}

export function buildSitemapXml(apps: DiscoverEntry[], base: string): string {
  const b = base.replace(/\/$/, "");
  const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const urls = [
    `<url><loc>${x(`${b}/`)}</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    ...apps.map((e) => {
      const mod = e.updatedAt && !Number.isNaN(Date.parse(e.updatedAt)) ? `<lastmod>${new Date(e.updatedAt).toISOString().slice(0, 10)}</lastmod>` : "";
      return `<url><loc>${x(`${b}${detailPath(e)}`)}</loc>${mod}<changefreq>weekly</changefreq><priority>0.8</priority></url>`;
    }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`;
}
