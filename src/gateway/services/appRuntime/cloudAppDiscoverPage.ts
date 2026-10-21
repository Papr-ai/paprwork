/**
 * apps.papr.ai Discover: data + routes.
 *
 * Lists the same apps as the desktop Discover tab (public, Community-listed, published,
 * and "Edit the code" on — codeAccess=install), server-rendered so every app has its own
 * crawlable page (/discover/{ns}/{slug}), plus sitemap.xml and robots.txt.
 * Signed-in visitors also get a "My apps" tab (their publishes + apps shared with them).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response } from "express";
import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";
import { getCloudAppHostKey, runtimeFetch } from "./memoryRuntimeClient.js";
import { getCloudAppPublicBaseUrl } from "./CloudAppPreviewService.js";
import { buildDiscoverHtml, buildRobotsTxt, buildSitemapXml, type DiscoverView } from "./cloudAppDiscoverHtml.js";

export interface DiscoverMedia {
  kind?: string;
  role?: string;
  url?: string | null;
  posterUrl?: string | null;
  alt?: string | null;
}

export interface DiscoverEntry {
  appId?: string;
  namespaceId: string;
  slug: string;
  shareUrl: string;
  codeAccess?: string;
  visibility?: string;
  name?: string | null;
  description?: string | null;
  icon?: string | null;
  author?: string | null;
  publisherUserId?: string | null;
  catalogCategory?: string | null;
  catalogHeadline?: string | null;
  catalogMedia?: DiscoverMedia[] | null;
  catalogRequirements?: Array<{ name?: string; service?: string }> | null;
  catalogAutomation?: { cardLine?: string } | null;
  updatedAt?: string | null;
  installCount?: number | null;
}

export interface DiscoverSessionReader {
  getSessionToken(req: Request): string | undefined;
  getExternalUserId(req: Request): string | undefined;
  getSessionEmail(req: Request): string | undefined;
}

const CACHE_MS = 5 * 60_000;
let cache: { at: number; apps: DiscoverEntry[] } | null = null;

const usable = (a: DiscoverEntry | null | undefined): a is DiscoverEntry =>
  Boolean(a?.slug && a.namespaceId && a.name?.trim());

/** Desktop Discover rule: only apps whose code others can install (codeAccess=install). */
export function isDiscoverListed(a: DiscoverEntry): boolean {
  return usable(a) && a.codeAccess === "install";
}

/** Community listing for Discover; last good list (or []) when memory is unreachable. */
export async function fetchDiscoverEntries(): Promise<DiscoverEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.apps;
  try {
    const res = await runtimeFetch(
      `${getMemoryServerBaseUrl()}/v1/cloud/apps/runtime/community`,
      { headers: { "X-Cloud-App-Host-Key": getCloudAppHostKey() } },
      15_000,
    );
    if (!res.ok) throw new Error(`memory ${res.status}`);
    const data = (await res.json()) as { apps?: DiscoverEntry[] };
    const apps = (Array.isArray(data.apps) ? data.apps : []).filter(isDiscoverListed);
    cache = { at: Date.now(), apps };
    return apps;
  } catch (err) {
    console.warn("[CloudAppHost] Discover catalog unavailable:", (err as Error).message);
    return cache?.apps ?? [];
  }
}

/** Apps the signed-in user can open (own publishes + team/public in their workspaces). */
export async function fetchMyApps(sessionToken: string): Promise<DiscoverEntry[] | null> {
  try {
    const res = await runtimeFetch(
      `${getMemoryServerBaseUrl()}/v1/cloud/apps/accessible`,
      { headers: { "X-Session-Token": sessionToken } },
      15_000,
    );
    if (!res.ok) throw new Error(`memory ${res.status}`);
    const data = (await res.json()) as { apps?: DiscoverEntry[] };
    return (Array.isArray(data.apps) ? data.apps : []).filter(usable);
  } catch (err) {
    console.warn("[CloudAppHost] My apps unavailable:", (err as Error).message);
    return null;
  }
}

const ASSET_RE = /^drop-(light|dark)\.png$/;
const assetCache = new Map<string, Buffer | null>();
function loadAsset(file: string): Buffer | null {
  if (assetCache.has(file)) return assetCache.get(file)!;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "../../../resources/discover", file),
    path.join(process.cwd(), "dist/resources/discover", file),
    path.join(process.cwd(), "src/resources/discover", file),
  ];
  let buf: Buffer | null = null;
  for (const p of candidates) {
    try { buf = fs.readFileSync(p); break; } catch { /* next */ }
  }
  assetCache.set(file, buf);
  return buf;
}

export function registerDiscoverRoutes(app: Express, session: DiscoverSessionReader): void {
  const render = async (req: Request, res: Response, view: DiscoverView, focus?: { ns: string; slug: string }) => {
    try {
      const sessionToken = session.getSessionToken(req);
      const [apps, mine] = await Promise.all([
        fetchDiscoverEntries(),
        sessionToken ? fetchMyApps(sessionToken) : Promise.resolve(null),
      ]);
      let focused: DiscoverEntry | undefined;
      if (focus) {
        const match = (a: DiscoverEntry) => a.namespaceId === focus.ns && a.slug === focus.slug;
        focused = apps.find(match) ?? mine?.find(match);
        if (!focused) {
          res.redirect(302, "/");
          return;
        }
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Vary", "Cookie");
      res.setHeader(
        "Cache-Control",
        sessionToken ? "private, no-store" : "public, max-age=60, stale-while-revalidate=300",
      );
      res.send(
        buildDiscoverHtml({
          view,
          apps,
          mine,
          focused,
          // A detail page only an owner/teammate can see must not be indexed.
          focusedIsPublic: focused ? apps.includes(focused) : true,
          signedIn: Boolean(sessionToken),
          userId: session.getExternalUserId(req),
          email: session.getSessionEmail(req),
          publicBaseUrl: getCloudAppPublicBaseUrl(req),
        }),
      );
    } catch (err) {
      res.status(500).send((err as Error).message);
    }
  };

  app.get("/", (req, res) => void render(req, res, "discover"));
  app.get("/discover", (req, res) => void render(req, res, "discover"));
  app.get("/my-apps", (req, res) => void render(req, res, "mine"));
  app.get("/discover/_/:file", (req, res) => {
    const file = String(req.params.file ?? "");
    const buf = ASSET_RE.test(file) ? loadAsset(file) : null;
    if (!buf) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  });
  app.get("/discover/:ns/:slug", (req, res) =>
    void render(req, res, "discover", { ns: String(req.params.ns), slug: String(req.params.slug) }),
  );
  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send(buildRobotsTxt(getCloudAppPublicBaseUrl(req)));
  });
  app.get("/sitemap.xml", async (req, res) => {
    const apps = await fetchDiscoverEntries();
    res.setHeader("Cache-Control", "public, max-age=600");
    res.type("application/xml").send(buildSitemapXml(apps, getCloudAppPublicBaseUrl(req)));
  });
}
