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
  if (lower.includes(".backup-")) return true;
  if (lower.includes(".corrupt-")) return true;
  if (lower.includes("corrupt-backup")) return true;
  return false;
}

export function isTooLargeForGitSync(sizeBytes: number): boolean {
  return sizeBytes > MAX_GIT_SYNC_FILE_BYTES;
}

/**
 * Explain a skipped file in terms of what to do about it.
 *
 * Skipping used to be a bare warning, which reads as "we handled it" — and the
 * app then published with the asset silently missing. There is now a real
 * destination for these bytes, so the message names it. Mentioning the app the
 * file belongs to matters: the author sees a path, not a filename.
 */
export function describeOversizedSkip(
  relativePaths: readonly string[],
): string {
  const shown = relativePaths.slice(0, 5);
  const more = relativePaths.length - shown.length;
  const noun = relativePaths.length === 1 ? "file is" : "files are";
  return (
    `${relativePaths.length} ${noun} over ${formatGitSyncSizeLimitMb()} and will not sync to GitHub:\n` +
    shown.map((p) => `  • ${p}`).join("\n") +
    (more > 0 ? `\n  • …and ${more} more` : "") +
    `\nStore them with App Files instead — the bytes go to object storage and the ` +
    `app keeps a reference, so publishing serves them correctly.`
  );
}
