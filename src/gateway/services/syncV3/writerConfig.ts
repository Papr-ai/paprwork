/**
 * Desktop / writer service configuration for Sync V3 ops path.
 */

/** Cloud Run writer used by every shipped build (also in packaged-gateway-env.defaults.json). */
export const PRODUCTION_APP_REPO_WRITER_URL =
  "https://app-repo-writer-223473570766.us-west1.run.app";

/** Local writer for `npm run start:app-repo-writer`. Opt in via PAPR_APP_REPO_WRITER_URL. */
export const LOCAL_APP_REPO_WRITER_URL = "http://127.0.0.1:8789";

export function getAppRepoWriterBaseUrl(): string {
  const explicit =
    process.env.PAPR_APP_REPO_WRITER_URL ?? process.env.SYNC_WRITER_URL;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim().replace(/\/$/, "");
  }
  // Never default to localhost: when packaged env is missing or the app runs
  // unpackaged, a localhost default makes every Upload now fail with
  // "fetch failed" (ECONNREFUSED) instead of syncing to the real writer.
  return PRODUCTION_APP_REPO_WRITER_URL;
}

/** True when the resolved writer is a developer-local instance. */
export function isLocalAppRepoWriter(): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(
    getAppRepoWriterBaseUrl(),
  );
}

/** App code always syncs via writer ops (V3 — no namespace git for apps). */
export function shouldUseWriterOpsPath(): boolean {
  return true;
}

/** Per-app GitHub repos via memory RepoRegistry (always on). */
export function isPerAppReposEnabled(): boolean {
  return true;
}
