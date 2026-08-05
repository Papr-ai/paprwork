/**
 * Cloud git sync size and artifact rules.
 * Small PDFs/assets sync normally; files over the limit are skipped at commit time.
 */

/** GitHub warns above ~50MB; skip staging above 10MB to avoid push failures. */
export const MAX_GIT_SYNC_FILE_BYTES = 10 * 1024 * 1024;

export function formatGitSyncSizeLimitMb(): string {
  return `${MAX_GIT_SYNC_FILE_BYTES / (1024 * 1024)}MB`;
}

/** Recovery backups — gitignored, never pushed to GitHub. */
export function isLocalOnlyCloudSyncArtifact(baseName: string): boolean {
  const lower = baseName.toLowerCase();
  if (lower.endsWith(".bak")) return true;
  if (lower.includes(".bak.")) return true;
  if (lower.includes(".backup.")) return true;
  if (lower.includes(".corrupt-")) return true;
  if (lower.includes("corrupt-backup")) return true;
  return false;
}

export function isTooLargeForGitSync(sizeBytes: number): boolean {
  return sizeBytes > MAX_GIT_SYNC_FILE_BYTES;
}
