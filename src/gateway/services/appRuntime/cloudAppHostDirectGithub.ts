/**
 * Cloud App Host — direct GitHub repo reads (Phase 1 performance).
 *
 * When enabled, file fetches use POST /v1/cloud/apps/runtime/repo-credentials
 * instead of per-file runtime/repo-file hops through the memory server.
 *
 * Set CLOUD_APP_HOST_DIRECT_GITHUB=0 to fall back to runtime/repo-file.
 */

export function isDirectGithubRepoFetchEnabled(): boolean {
  const raw = process.env.CLOUD_APP_HOST_DIRECT_GITHUB;
  if (raw === undefined || raw === "") {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "no";
}
