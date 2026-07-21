/**
 * Published app URL path helpers (trailing slash + relative asset resolution).
 */

/** True for `/namespaceId/slug` app roots (not nested files). */
export function isPublishedAppRootPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 2;
}

/** App roots must end with `/` so relative `layout.css` resolves under the slug. */
export function ensurePublishedAppRootTrailingSlash(pathname: string): string {
  if (!isPublishedAppRootPath(pathname)) {
    return pathname;
  }
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

export function publishedAppBaseHref(namespaceId: string, slug: string): string {
  return `/${namespaceId}/${slug}/`;
}

export function injectPublishedAppBaseHref(html: string, baseHref: string): string {
  if (html.includes("<base ")) {
    return html;
  }
  const tag = `<base href="${baseHref}">`;
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n  ${tag}`);
  }
  if (html.includes("<head ")) {
    return html.replace(/<head\s[^>]*>/, (match) => `${match}\n  ${tag}`);
  }
  return html;
}

function normalizeShareUrlPath(shareUrl: string): string {
  try {
    const url = new URL(shareUrl);
    url.pathname = ensurePublishedAppRootTrailingSlash(url.pathname);
    return url.toString();
  } catch {
    const qIndex = shareUrl.indexOf("?");
    const path = qIndex === -1 ? shareUrl : shareUrl.slice(0, qIndex);
    const query = qIndex === -1 ? "" : shareUrl.slice(qIndex);
    return `${ensurePublishedAppRootTrailingSlash(path)}${query}`;
  }
}

export function normalizeCloudShareUrl(shareUrl: string): string {
  return normalizeShareUrlPath(shareUrl);
}
