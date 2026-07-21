/**
 * Cloud App Host → Memory server publish/ACL APIs (no host key — public or user session).
 */

import { getMemoryServerBaseUrl } from "../../utils/cloudApiClient.js";

export type PublishedAppVisibility =
  | "private"
  | "team"
  | "link_read"
  | "link_read_write"
  | "public_read";

export interface PublishedAppResolveResult {
  orgId: string;
  namespaceId: string;
  userId: string;
  appId: string;
  slug: string;
  visibility: PublishedAppVisibility;
  linkPermission: "read" | "read_write";
}

function memoryHeaders(sessionToken?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (sessionToken) {
    headers["X-Session-Token"] = sessionToken;
  }
  return headers;
}

export async function resolvePublishedApp(
  namespaceId: string,
  slug: string,
  sessionToken?: string,
): Promise<PublishedAppResolveResult | null> {
  const res = await fetch(
    `${getMemoryServerBaseUrl()}/v1/cloud/apps/resolve/${encodeURIComponent(namespaceId)}/${encodeURIComponent(slug)}`,
    { headers: memoryHeaders(sessionToken) },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Resolve app failed (${res.status})`);
  }
  return res.json() as Promise<PublishedAppResolveResult>;
}

export function visibilityRequiresPaprLogin(visibility: PublishedAppVisibility): boolean {
  return visibility === "private" || visibility === "team";
}

export function visibilityRequiresShareToken(visibility: PublishedAppVisibility): boolean {
  return visibility === "link_read" || visibility === "link_read_write";
}
