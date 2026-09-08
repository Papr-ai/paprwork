import type { Stats } from "fs";

/** Revalidate when file changes; browser may reuse bytes across retries in one session. */
export const MINI_APP_DIST_CACHE_CONTROL = "private, must-revalidate";

export function buildMiniAppDistEtag(stat: Pick<Stats, "mtimeMs" | "size">): string {
  return `W/"${Math.trunc(stat.mtimeMs)}-${stat.size}"`;
}

export function ifNoneMatchIncludes(
  ifNoneMatchHeader: string | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatchHeader) {
    return false;
  }
  const candidates = ifNoneMatchHeader.split(/\s*,\s*/).map((part) => part.trim());
  return candidates.includes("*") || candidates.includes(etag);
}

export function readIfNoneMatchHeader(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers["if-none-match"];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}
