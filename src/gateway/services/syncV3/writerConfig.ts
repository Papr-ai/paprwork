/**
 * Desktop / writer service configuration for Sync V3 ops path.
 */

export function getAppRepoWriterBaseUrl(): string {
  return (
    process.env.PAPR_APP_REPO_WRITER_URL ??
    process.env.SYNC_WRITER_URL ??
    "http://127.0.0.1:8789"
  ).replace(/\/$/, "");
}

/** App code always syncs via writer ops (V3 — no namespace git for apps). */
export function shouldUseWriterOpsPath(): boolean {
  return true;
}

/** Per-app GitHub repos via memory RepoRegistry (always on). */
export function isPerAppReposEnabled(): boolean {
  return true;
}
