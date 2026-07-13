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

export function resolveCloudRouteContext(input: {
  params?: { namespaceId?: string; slug?: string };
  query?: Record<string, unknown>;
  cookieHeader?: string;
  headers?: Record<string, string | string[] | undefined>;
}): CloudRouteContext | null {
  const cookies = parseCookieHeader(input.cookieHeader);

  const namespaceId =
    input.params?.namespaceId ??
    queryValue(input.query, "namespaceId") ??
    cookies.papr_cloud_ns ??
    headerValue(input.headers, "x-papr-namespace-id");

  const slug =
    input.params?.slug ??
    queryValue(input.query, "slug") ??
    cookies.papr_cloud_slug ??
    headerValue(input.headers, "x-papr-slug");

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
