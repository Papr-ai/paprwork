/**
 * Resolve namespace + slug for Cloud App Host routing and /api/db/* access.
 */

export interface CloudRouteContext {
  namespaceId: string;
  slug: string;
}

const RESERVED_SEGMENTS = new Set(["health", "api", "apps", "auth"]);

export function isReservedCloudPathSegment(segment: string): boolean {
  return RESERVED_SEGMENTS.has(segment.toLowerCase());
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  const value = headers?.[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value[0]) return value[0];
  return undefined;
}

function queryValue(query: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = query?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const PAPR_CLOUD_NAMESPACE_META = "papr-cloud-namespace";
export const PAPR_CLOUD_SLUG_META = "papr-cloud-slug";

export function injectPaprCloudContextMeta(
  html: string,
  namespaceId: string,
  slug: string,
): string {
  const escape = (value: string) => value.replace(/"/g, "&quot;");
  const tags = [
    `<meta name="${PAPR_CLOUD_NAMESPACE_META}" content="${escape(namespaceId)}">`,
    `<meta name="${PAPR_CLOUD_SLUG_META}" content="${escape(slug)}">`,
  ].join("\n  ");

  if (html.includes(`name="${PAPR_CLOUD_NAMESPACE_META}"`)) {
    return html
      .replace(
        new RegExp(`<meta name="${PAPR_CLOUD_NAMESPACE_META}" content="[^"]*">`),
        `<meta name="${PAPR_CLOUD_NAMESPACE_META}" content="${escape(namespaceId)}">`,
      )
      .replace(
        new RegExp(`<meta name="${PAPR_CLOUD_SLUG_META}" content="[^"]*">`),
        `<meta name="${PAPR_CLOUD_SLUG_META}" content="${escape(slug)}">`,
      );
  }

  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n  ${tags}`);
  }
  if (/<head\s[^>]*>/i.test(html)) {
    return html.replace(/<head\s[^>]*>/i, (match) => `${match}\n  ${tags}`);
  }
  return `${tags}\n${html}`;
}

export function resolveCloudRouteContext(input: {
  params?: { namespaceId?: string; slug?: string };
  query?: Record<string, unknown>;
  cookieHeader?: string;
  headers?: Record<string, string | string[] | undefined>;
}): CloudRouteContext | null {
  const cookies = parseCookieHeader(input.cookieHeader);

  // Per-tab meta → request headers beat site-wide cookies (multi-tab / back-nav safe).
  const namespaceId =
    input.params?.namespaceId ??
    queryValue(input.query, "namespaceId") ??
    headerValue(input.headers, "x-papr-namespace-id") ??
    cookies.papr_cloud_ns;

  const slug =
    input.params?.slug ??
    queryValue(input.query, "slug") ??
    headerValue(input.headers, "x-papr-slug") ??
    cookies.papr_cloud_slug;

  if (!namespaceId || !slug) return null;
  if (isReservedCloudPathSegment(namespaceId)) return null;
  return { namespaceId, slug };
}

export function cloudContextCookieHeaders(
  namespaceId: string,
  slug: string,
  secure: boolean,
): string[] {
  const suffix = `Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  return [
    `papr_cloud_ns=${encodeURIComponent(namespaceId)}; ${suffix}`,
    `papr_cloud_slug=${encodeURIComponent(slug)}; ${suffix}`,
  ];
}
