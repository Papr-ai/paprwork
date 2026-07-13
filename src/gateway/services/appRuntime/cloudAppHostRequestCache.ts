/**
 * Detect browser reload / revalidation requests for published app assets.
 * Normal refresh (F5) sends Cache-Control: max-age=0 — not only hard reload.
 */

export function shouldBypassRepoFileCache(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const cacheControl = headerValue(headers["cache-control"]).toLowerCase();
  if (cacheControl.includes("no-cache")) {
    return true;
  }
  if (cacheControl.includes("max-age=0")) {
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
