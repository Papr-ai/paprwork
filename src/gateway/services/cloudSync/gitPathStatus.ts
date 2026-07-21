/**
 * Helpers for deciding whether a Papr folder is already reflected in git
 * (working tree clean + tracked files) even when sync state was never marked.
 */

export function canReconcilePathAsSynced(opts: {
  exists: boolean;
  porcelain: string;
  trackedFiles: string;
}): boolean {
  if (!opts.exists) {
    return false;
  }
  if (opts.porcelain.trim().length > 0) {
    return false;
  }
  return opts.trackedFiles.trim().length > 0;
}
