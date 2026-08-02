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

export function buildPreviewLandingHtml(
  meta: CloudAppPreviewMeta,
  message: string,
  options?: { loginUrl?: string; showLoginButton?: boolean; headline?: string },
): string {
  const headTags = buildPreviewHeadTags(meta);
  const title = escapeHtmlAttribute(meta.title);
  const description = escapeHtmlAttribute(meta.description);
  const safeMessage = escapeHtmlAttribute(message);
  const gateHeadline = options?.headline
    ? escapeHtmlAttribute(options.headline)
    : null;
  const showLoginButton = options?.showLoginButton !== false;
  const loginUrl = options?.loginUrl
    ? escapeHtmlAttribute(options.loginUrl)
    : null;
  const loginBlock =
    showLoginButton && loginUrl
      ? `<p class="actions"><a class="btn" href="${loginUrl}" target="_blank" rel="noopener noreferrer">Sign in with Papr</a></p>`
      : "";
  const headlineBlock = gateHeadline
    ? `<p class="status">${gateHeadline}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${headTags}
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f5f5f7; color: #1d1d1f; }
    main { max-width: 560px; margin: 10vh auto; padding: 32px 24px; background: #fff; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.08); }
    h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.2; }
    p { margin: 0 0 12px; color: #515154; line-height: 1.5; }
    .hint { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e5e5ea; font-size: 14px; }
    .status { margin: 0 0 12px; font-size: 15px; font-weight: 600; color: #1d1d1f; }
    .actions { margin-top: 20px; }
    .btn { display: inline-block; padding: 10px 16px; border-radius: 999px; background: #0060e0; color: #fff; text-decoration: none; font-weight: 600; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${description}</p>
    ${headlineBlock}
    <p class="hint">${safeMessage}</p>
    ${loginBlock}
  </main>
</body>
</html>`;
}
