/**
 * Job runtime is always off git (Sync V3).
 * Runtime lives in gitignored files + memory heartbeat/Mongo — git carries config only.
 */
export function isJobRuntimeOffGit(): boolean {
  return true;
}
