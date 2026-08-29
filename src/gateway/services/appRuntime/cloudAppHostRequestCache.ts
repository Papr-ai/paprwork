/**
 * Detect browser hard-reload requests for published app assets.
 * Normal refresh (F5) sends Cache-Control: max-age=0 — that must NOT bypass
 * server-side repo caches; revision markers bust caches after Sync now.
 */

export function shouldBypassRepoFileCache(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const cacheControl = headerValue(headers["cache-control"]).toLowerCase();
  if (cacheControl.includes("no-cache") && cacheControl.includes("no-store")) {
    return true;
  }
  if (headerValue(headers["pragma"]).toLowerCase() === "no-cache") {
    return true;
  }
  return false;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}
