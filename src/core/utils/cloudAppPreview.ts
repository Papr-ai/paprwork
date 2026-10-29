/**
 * Link preview / Open Graph helpers for cloud mini-apps.
 */

import {
  buildDefaultCloudAppDescription,
  humanizeCloudAppSlug,
} from "./cloudAppMetadata.js";

/** Product name for apps.papr.ai link previews (matches Electron productName). */
export const CLOUD_APP_SITE_NAME = "Papr Work";

export interface CloudAppPreviewMeta {
  title: string;
  description: string;
  canonicalUrl: string;
  iconUrl: string;
  imageUrl: string;
  siteName: string;
}

const LINK_PREVIEW_CRAWLER_PATTERN =
  /bot|crawler|spider|preview|slack|discord|facebook|twitter|linkedin|telegram|whatsapp|applebot|embedly|iframely|vkshare|reddit/i;

export function isLinkPreviewCrawler(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return LINK_PREVIEW_CRAWLER_PATTERN.test(userAgent);
}

export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildPreviewMetaFromSlug(
  slug: string,
  canonicalUrl: string,
  iconUrl: string,
  imageUrl: string,
): CloudAppPreviewMeta {
  const title = humanizeCloudAppSlug(slug);
  return {
    title,
    description: buildDefaultCloudAppDescription(title),
    canonicalUrl,
    iconUrl,
    imageUrl,
    siteName: CLOUD_APP_SITE_NAME,
  };
}

export function buildPreviewHeadTags(meta: CloudAppPreviewMeta): string {
  const title = escapeHtmlAttribute(meta.title);
  const description = escapeHtmlAttribute(meta.description);
  const canonicalUrl = escapeHtmlAttribute(meta.canonicalUrl);
  const iconUrl = escapeHtmlAttribute(meta.iconUrl);
  const imageUrl = escapeHtmlAttribute(meta.imageUrl);
  const siteName = escapeHtmlAttribute(meta.siteName);

  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<link rel="icon" href="${iconUrl}">`,
    `<link rel="apple-touch-icon" href="${iconUrl}">`,
    // Installable as its own desktop/Dock app (Chrome/Edge "Install" in the address bar).
    // use-credentials so signed-in visitors get repo metadata (title/description).
    `<link rel="manifest" href="${escapeHtmlAttribute(buildWebAppManifestUrl(meta))}" crossorigin="use-credentials">`,
    `<meta name="theme-color" content="${CLOUD_APP_THEME_COLOR}">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-title" content="${title}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${siteName}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${canonicalUrl}">`,
    `<meta property="og:image" content="${imageUrl}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${imageUrl}">`,
  ].join("\n  ");
}

/** Browser chrome color for installed (standalone) mini-app windows. */
export const CLOUD_APP_THEME_COLOR = "#ffffff";

export const CLOUD_APP_MANIFEST_PATH = "manifest.webmanifest";

/** `{canonical}/manifest.webmanifest`, keeping a share token so link visitors can install. */
export function buildWebAppManifestUrl(meta: Pick<CloudAppPreviewMeta, "canonicalUrl" | "iconUrl">): string {
  const base = meta.canonicalUrl.endsWith("/") ? meta.canonicalUrl : `${meta.canonicalUrl}/`;
  const token = shareTokenFromUrl(meta.iconUrl);
  return token ? `${base}${CLOUD_APP_MANIFEST_PATH}?t=${encodeURIComponent(token)}` : `${base}${CLOUD_APP_MANIFEST_PATH}`;
}

function withQuery(url: string, key: string, value: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

function shareTokenFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("t");
  } catch {
    return null;
  }
}

/** Short name for the Dock / taskbar label (Chrome truncates around 12 chars). */
export function shortAppName(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= 12) return clean;
  const firstPart = clean.split(/\s[·|—–-]\s|:\s/)[0]?.trim() ?? clean;
  return firstPart.length <= 24 ? firstPart : `${firstPart.slice(0, 23).trimEnd()}…`;
}

/**
 * Per-app Web App Manifest. Each published app is its own installable app:
 * scope = the app's root, so installs of different apps never collide.
 */
export function buildWebAppManifest(meta: CloudAppPreviewMeta): Record<string, unknown> {
  const root = new URL(meta.canonicalUrl);
  const scope = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
  const token = shareTokenFromUrl(meta.iconUrl);
  const startUrl = token ? `${scope}?t=${encodeURIComponent(token)}` : scope;
  return {
    id: scope,
    name: meta.title,
    short_name: shortAppName(meta.title),
    description: meta.description,
    start_url: startUrl,
    scope,
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    background_color: CLOUD_APP_THEME_COLOR,
    theme_color: CLOUD_APP_THEME_COLOR,
    icons: [
      { src: withQuery(meta.iconUrl, "size", "192"), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: meta.iconUrl, sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}

export function injectPreviewHeadTags(html: string, headTags: string): string {
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n  ${headTags}`);
  }
  if (html.includes("<head ")) {
    return html.replace(/<head\s[^>]*>/, (match) => `${match}\n  ${headTags}`);
  }
  return html;
}

export const CLOUD_APP_SIGN_IN_HEADLINE = "Sign in is required to access this app.";
export const CLOUD_APP_LOGIN_BUTTON_LABEL = "Sign in";
export const CLOUD_APP_SIGNUP_BUTTON_LABEL = "Create Papr account";
export const CLOUD_APP_LOGIN_VIA_NOTE =
  "Sign in with an existing Papr account, or create one if you're new.";

/** Cloud App Host Auth0 entry — `mode=signup` opens Auth0 registration. */
export function buildCloudAuthLoginUrl(
  returnTo: string,
  mode: "login" | "signup" = "login",
): string {
  const params = new URLSearchParams({ returnTo });
  if (mode === "signup") {
    params.set("mode", "signup");
  }
  return `/auth/login?${params.toString()}`;
}

/** Papr mark (same gradient as the Discover top bar). */
const PAPR_LOGO_MARK = `<svg viewBox="0 0 105 124" width="18" height="22" fill="none" aria-hidden="true"><path d="M28 101.5C-11.5 158 7 51 43.4 60.5c55.9 14.6 71.8-39.7 40.3-52.2C40.3-8.9 52 65 28 101.5Z" stroke="url(#gpl)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="gpl" x1="17.2" y1="89.4" x2="68.9" y2="35.8" gradientUnits="userSpaceOnUse"><stop stop-color="#0060E0"/><stop offset=".6" stop-color="#00ACFA"/><stop offset="1" stop-color="#0BCDFF"/></linearGradient></defs></svg>`;

export interface PreviewLandingOptions {
  loginUrl?: string;
  signupUrl?: string;
  showLoginButton?: boolean;
  headline?: string;
  /** Inline SVG from the published app repo (preferred over iconUrl on the gate page). */
  iconSvg?: string;
}

export function buildPreviewLandingHtml(
  meta: CloudAppPreviewMeta,
  message: string,
  options?: PreviewLandingOptions,
): string {
  const headTags = buildPreviewHeadTags(meta);
  const title = escapeHtmlAttribute(meta.title);
  const description = escapeHtmlAttribute(meta.description);
  const safeMessage = escapeHtmlAttribute(message.trim());
  const gateHeadline = escapeHtmlAttribute(options?.headline ?? CLOUD_APP_SIGN_IN_HEADLINE);
  const showLoginButton = options?.showLoginButton !== false;
  const loginUrl = options?.loginUrl
    ? escapeHtmlAttribute(options.loginUrl)
    : null;
  const signupUrl = options?.signupUrl
    ? escapeHtmlAttribute(options.signupUrl)
    : null;
  const iconUrl = escapeHtmlAttribute(meta.iconUrl);
  // Same glyph as the Discover app page: the app's logo inside the Papr glass droplet.
  const iconMarkup = options?.iconSvg?.trim().startsWith("<svg")
    ? `<span class="app-icon drop" aria-hidden="true">${options.iconSvg.trim()}</span>`
    : `<span class="app-icon app-icon--img" aria-hidden="true"><img src="${iconUrl}" alt="" width="88" height="88"></span>`;
  const detailBlock = safeMessage
    ? `<p class="gate-detail">${safeMessage}</p>`
    : "";
  const loginBlock =
    showLoginButton && loginUrl
      ? `<div class="gate-actions">
        <a class="btn btn--primary" href="${loginUrl}" target="_blank" rel="noopener noreferrer">${CLOUD_APP_LOGIN_BUTTON_LABEL}</a>${
        signupUrl
          ? `
        <a class="btn btn--secondary" href="${signupUrl}" target="_blank" rel="noopener noreferrer">${CLOUD_APP_SIGNUP_BUTTON_LABEL}</a>`
          : ""
      }
      </div>
      <p class="gate-via">${CLOUD_APP_LOGIN_VIA_NOTE}</p>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${headTags}
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light dark; --bg:#f5f5f7; --card:#fff; --tx:#1d1d1f; --tx2:#6e6e73; --tx3:#8e8e93; --line:rgba(10,16,32,.08); --acc:#0060e0; --chip:rgba(0,0,0,.06); --drop:url(/discover/_/drop-light.png); --ink:rgba(55,65,88,.78); }
    @media (prefers-color-scheme: dark) { :root { --bg:#0b0c10; --card:#16171c; --tx:#f5f5f7; --tx2:#a1a1a6; --tx3:#8e8e93; --line:rgba(255,255,255,.09); --acc:#3b8bff; --chip:rgba(255,255,255,.09); --drop:url(/discover/_/drop-dark.png); --ink:rgba(210,218,232,.9); } }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--tx); font: 15px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
    a { color: inherit; text-decoration: none; }
    .top { display: flex; align-items: center; padding: 12px clamp(16px,4vw,40px); }
    .logo { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 17px; letter-spacing: -.02em; }
    main { flex: 1; display: grid; place-items: center; padding: 16px 16px 48px; }
    .gate { width: min(440px, 100%); display: grid; justify-items: center; text-align: center; padding: 40px 32px 32px; border-radius: 26px; background: var(--card); box-shadow: 0 0 0 1px var(--line), 0 18px 50px rgba(10,16,32,.08); animation: pop .3s cubic-bezier(.2,.8,.2,1) both; }
    .app-brand { display: grid; justify-items: center; gap: 16px; }
    .app-icon { width: 88px; height: 88px; display: grid; place-items: center; border-radius: 50%; overflow: hidden; }
    .drop { background: var(--drop) center/cover no-repeat, radial-gradient(circle at 35% 30%, #fff, color-mix(in srgb, var(--acc) 10%, var(--card))); box-shadow: 0 8px 24px rgba(1,50,120,.12); color: var(--ink); }
    .drop svg { width: 46%; height: 46%; display: block; }
    .app-icon--img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    h1 { margin: 0; font-size: 30px; font-weight: 700; letter-spacing: -.028em; line-height: 1.1; }
    .app-description { margin: 10px auto 0; max-width: 360px; font-size: 15px; line-height: 1.5; color: var(--tx2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .gate-status { margin: 24px 0 0; padding-top: 22px; width: 100%; border-top: 1px solid var(--line); font-size: 15px; font-weight: 650; color: var(--tx); line-height: 1.4; }
    .gate-detail { margin: 6px 0 0; color: var(--tx2); line-height: 1.5; font-size: 14px; }
    .gate-actions { margin-top: 20px; width: 100%; display: grid; gap: 10px; }
    .btn { height: 44px; display: inline-flex; align-items: center; justify-content: center; padding: 0 24px; border-radius: 14px; font-size: 15px; font-weight: 650; transition: filter .15s, transform .15s, background .15s; }
    .btn:active { transform: scale(.98); }
    .btn--primary { color: #fff; background: linear-gradient(180deg, color-mix(in srgb, var(--acc) 85%, #fff), var(--acc)); box-shadow: inset 0 1px 0 rgba(255,255,255,.25), 0 1px 2px rgba(1,97,224,.3), 0 6px 16px rgba(1,97,224,.22); }
    .btn--primary:hover { filter: brightness(1.08); }
    .btn--secondary { color: var(--acc); background: var(--chip); }
    .btn--secondary:hover { background: color-mix(in srgb, var(--tx) 10%, transparent); }
    .btn:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
    .gate-via { margin: 14px 0 0; font-size: 12.5px; color: var(--tx3); line-height: 1.45; }
    .foot { padding: 0 16px 24px; text-align: center; font-size: 12.5px; color: var(--tx3); }
    .foot a:hover { color: var(--tx); }
    @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.99); } }
    @media (max-width: 480px) { .gate { padding: 32px 20px 24px; border-radius: 22px; } h1 { font-size: 26px; } }
    @media (prefers-reduced-motion: reduce) { .gate { animation: none; } }
  </style>
</head>
<body>
  <header class="top"><a class="logo" href="/" title="Papr Work apps">${PAPR_LOGO_MARK}<span>Papr</span></a></header>
  <main>
    <section class="gate">
      <div class="app-brand">
        ${iconMarkup}
        <div>
          <h1>${title}</h1>
          <p class="app-description">${description}</p>
        </div>
      </div>
      <p class="gate-status">${gateHeadline}</p>
      ${detailBlock}
      ${loginBlock}
    </section>
  </main>
  <footer class="foot">Built on <a href="https://papr.ai">Papr</a></footer>
</body>
</html>`;
}
