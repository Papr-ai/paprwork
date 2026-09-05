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
    `<link rel="apple-touch-icon" href="${imageUrl}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${siteName}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${canonicalUrl}">`,
    `<meta property="og:image" content="${imageUrl}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${imageUrl}">`,
  ].join("\n  ");
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
  const iconMarkup = options?.iconSvg?.trim().startsWith("<svg")
    ? `<span class="app-icon app-icon--svg" aria-hidden="true">${options.iconSvg.trim()}</span>`
    : `<img class="app-icon" src="${iconUrl}" alt="" width="44" height="44">`;
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
    <p class="gate-via">${CLOUD_APP_LOGIN_VIA_NOTE}</p>
  </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${headTags}
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f5f5f7; color: #1d1d1f; }
    main { max-width: 480px; margin: 10vh auto; padding: 36px 28px 32px; background: #fff; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.08); text-align: center; }
    .app-brand { display: inline-flex; align-items: center; justify-content: center; gap: 14px; margin-bottom: 10px; text-align: left; }
    .app-icon { width: 44px; height: 44px; flex-shrink: 0; border-radius: 10px; object-fit: contain; }
    .app-icon--svg { display: inline-flex; align-items: center; justify-content: center; }
    .app-icon--svg svg { width: 44px; height: 44px; display: block; }
    h1 { margin: 0; font-size: 26px; line-height: 1.15; font-weight: 600; color: #1d1d1f; }
    .app-description { margin: 0 0 32px; color: #6e6e73; line-height: 1.45; font-size: 15px; font-style: italic; }
    .gate-status { margin: 0; font-size: 15px; font-weight: 600; color: #1d1d1f; line-height: 1.4; }
    .gate-detail { margin: 12px 0 0; color: #515154; line-height: 1.55; font-size: 14px; }
    .gate-actions { margin-top: 32px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; min-width: 220px; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px; transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s; }
    .btn--primary { background: #0060e0; color: #fff; border: 1px solid #0060e0; }
    .btn--secondary { background: #fff; color: #0060e0; border: 1px solid #0060e0; }
    .btn:hover { opacity: 0.92; transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); }
    .gate-via { margin: 4px 0 0; font-size: 12px; color: #86868b; line-height: 1.45; max-width: 320px; }
  </style>
</head>
<body>
  <main>
    <div class="app-brand">
      ${iconMarkup}
      <h1>${title}</h1>
    </div>
    <p class="app-description">${description}</p>
    <p class="gate-status">${gateHeadline}</p>
    ${detailBlock}
    ${loginBlock}
  </main>
</body>
</html>`;
}
