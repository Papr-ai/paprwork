/**
 * Throttled namespace git repo maintenance (runs on periodic pull tick).
 */

import {
  HYGIENE_INTERVAL_MS,
  REPO_SIZE_CRITICAL_BYTES,
} from "./repoHygiene.js";
import { runRepoMaintenance } from "./repoMaintenance.js";
import type { GitRunner } from "./gitRunner.js";

export interface CloudSyncRepoHygieneHost {
  getPaprDir(): string;
  getGitRunner(): GitRunner;
  getLastHygieneAtMs(): number;
  setLastHygieneAtMs: (ms: number) => void;
  setLastError: (error: string | null) => void;
}

export async function maybeRunRepoHygiene(host: CloudSyncRepoHygieneHost): Promise<void> {
  const now = Date.now();
  if (now - host.getLastHygieneAtMs() < HYGIENE_INTERVAL_MS) {
    return;
  }
  host.setLastHygieneAtMs(now);

  try {
    const result = await runRepoMaintenance(host.getGitRunner(), host.getPaprDir());
    const freedGb = (
      (result.gitDirBytesBefore - result.gitDirBytesAfter) /
      1073741824
    ).toFixed(2);
    if (
      result.tmpPacksRemoved > 0 ||
      result.untrackedFiles > 0 ||
      result.level !== "ok"
    ) {
      console.log(
        `[CloudSync] Repo hygiene: removed ${result.tmpPacksRemoved} temp pack(s), ` +
          `untracked ${result.untrackedFiles} file(s), freed ${freedGb} GB, ` +
          `repo now ${(result.gitDirBytesAfter / 1073741824).toFixed(2)} GB (${result.level})`,
      );
    }
    if (result.level === "critical") {
      host.setLastError(
        `Cloud Sync repo is ${(result.gitDirBytesAfter / 1073741824).toFixed(1)} GB — ` +
          `above the ${REPO_SIZE_CRITICAL_BYTES / 1073741824} GB limit. ` +
          `Large binaries are being skipped. Run repo cleanup from Settings → Sync.`,
      );
    }
  } catch (err) {
    console.warn(
      "[CloudSync] Repo hygiene failed:",
      (err as Error).message.slice(0, 160),
    );
  }
}
