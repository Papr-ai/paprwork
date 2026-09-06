/**
 * Pull app source from the Sync V3 per-app GitHub repo into $PAPR_HOME/apps/{appId}/.
 * Used by Get updates (per-app) — replaces legacy namespace git for app code.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprAppsRoot } from "../../../core/utils/paprRoot.js";
import { fileContentHash } from "../../utils/fileContentHash.js";
import { getAppService } from "../AppService.js";
import {
  cloneCloudAppSource,
  isGitRepositoryNotFoundError,
} from "../cloudSync/cloudGitClone.js";
import { appNeedsOrderedFlushAsync } from "../cloudSync/pendingLocalUploads.js";
import { getCloudSyncService } from "../cloudSync/cloudSyncSingleton.js";
import { computeBlobOidForContent } from "./computeParentHash.js";
import { fetchAppRepoHead } from "./AppOpsClient.js";
import { writeAppRepoCommitCursor, readAppRepoCommitCursors } from "./appRepoCommittedFanout.js";
import {
  isAppCodeRecentlyVerified,
  isLocalAppCodeAtRemoteHead,
} from "./appRepoHeadSyncCheck.js";
import { ensureAppRepoRecord, fetchAppRepoReadCredentials, getAppRepoRecord } from "./AppRepoClient.js";
import {
  applyAckedBlobOids,
  readOidCache,
} from "./OidCache.js";

export interface PullAppCodeFromRepoResult {
  appId: string;
  commitSha: string | null;
  updatedFiles: string[];
  conflictFiles: string[];
  skippedFiles: string[];
  skipped?: boolean;
  reason?: string;
}

async function collectTextFiles(rootDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = path.relative(rootDir, full).replace(/\\/g, "/");
      files.set(rel, await fs.readFile(full, "utf8"));
    }
  }

  await walk(rootDir);
  return files;
}

function hashContent(content: string): string {
  return fileContentHash(content);
}

/** Merge remote repo tree into local app dir using OID cache for conflict detection. */
export async function pullAppCodeFromRepo(
  appId: string,
  options: { token: string | null; allowRecentSkip?: boolean },
): Promise<PullAppCodeFromRepoResult> {
  const { PhaseTimer } = await import("../../utils/phaseTiming.js");
  const timer = new PhaseTimer();
  const trimmed = appId.trim();
  const empty: PullAppCodeFromRepoResult = {
    appId: trimmed,
    commitSha: null,
    updatedFiles: [],
    conflictFiles: [],
    skippedFiles: [],
  };

  if (!trimmed) {
    return { ...empty, skipped: true, reason: "appId required" };
  }

  const sync = getCloudSyncService();
  if (sync && (await appNeedsOrderedFlushAsync(sync, trimmed))) {
    timer.mark("pendingUploadCheck");
    timer.logIfSlow(`PullAppCode skip-pending app=${trimmed}`, 50);
    return {
      ...empty,
      skipped: true,
      reason: "local changes pending upload — upload or discard before pulling code",
    };
  }
  timer.mark("pendingUploadCheck");

  let record = await getAppRepoRecord(trimmed);
  if (!record) {
    try {
      record = await ensureAppRepoRecord(trimmed);
    } catch {
      timer.logIfSlow(`PullAppCode no-repo app=${trimmed}`, 200);
      return { ...empty, skipped: true, reason: "no per-app repo registered" };
    }
  }
  timer.mark("repoRecord");

  if (options.allowRecentSkip !== false) {
    const cursors = await readAppRepoCommitCursors();
    const recent = isAppCodeRecentlyVerified(trimmed, cursors);
    if (recent.verified) {
      timer.mark("recentVerifySkip");
      timer.logIfSlow(`PullAppCode skip-recent app=${trimmed}`, 50);
      return {
        ...empty,
        commitSha: recent.commitSha,
        skipped: true,
        reason: "verified recently",
      };
    }
  }
  timer.mark("recentVerifyCheck");

  let head;
  try {
    head = await fetchAppRepoHead(trimmed, { seedOidCache: false });
  } catch (err) {
    timer.logIfSlow(`PullAppCode head-fail app=${trimmed}`, 200);
    return {
      ...empty,
      skipped: true,
      reason: (err as Error).message.slice(0, 120),
    };
  }
  timer.mark("fetchHead");

  if (await isLocalAppCodeAtRemoteHead(trimmed, head)) {
    await writeAppRepoCommitCursor(trimmed, head.commitSha);
    timer.mark("headUpToDate");
    timer.logIfSlow(`PullAppCode skip-head app=${trimmed}`, 50);
    return {
      ...empty,
      commitSha: head.commitSha,
      skipped: true,
      reason: "already at remote head",
    };
  }

  const remoteOidByPath = new Map(head.files.map((file) => [file.path, file.blobOid]));

  const readCreds = await fetchAppRepoReadCredentials(trimmed);
  timer.mark("readCreds");
  const cloneToken = readCreds?.token ?? options.token;
  const cloneUrl = readCreds?.cloneUrl ?? record.cloneUrl;
  const cloneRepoPath = readCreds?.repoPath ?? "";

  if (!cloneToken?.trim()) {
    return { ...empty, skipped: true, reason: "cloud login required" };
  }

  let sourceDir: string;
  let cleanup: () => Promise<void>;
  try {
    const cloned = await cloneCloudAppSource(
      {
        cloneUrl,
        token: cloneToken,
        repoPath: cloneRepoPath,
      },
      "papr-app-pull-",
    );
    sourceDir = cloned.sourceDir;
    cleanup = cloned.cleanup;
  } catch (err) {
    timer.mark("gitClone-failed");
    timer.logIfSlow(`PullAppCode clone-fail app=${trimmed}`, 200);
    if (isGitRepositoryNotFoundError(err)) {
      const reason = readCreds
        ? "per-app GitHub repo not provisioned yet — upload local changes or wait for cloud sync"
        : "cannot access per-app repo — sign in to Papr and retry Get updates";
      return {
        ...empty,
        skipped: true,
        reason,
      };
    }
    return {
      ...empty,
      skipped: true,
      reason: (err as Error).message.slice(0, 120),
    };
  }

  timer.mark("gitClone");

  try {
    const upstreamFiles = await collectTextFiles(sourceDir);
    timer.mark("collectRemote");
    const appDir = path.join(getPaprAppsRoot(), trimmed);
    const localFiles = (await fs.stat(appDir).catch(() => null))
      ? await collectTextFiles(appDir)
      : new Map<string, string>();
    timer.mark("collectLocal");

    const oidCache = await readOidCache();
    const cachedPaths = oidCache.apps[trimmed] ?? {};

    const appService = getAppService();
    const updatedFiles: string[] = [];
    const conflictFiles: string[] = [];
    const skippedFiles: string[] = [];

    for (const [filePath, upstreamContent] of upstreamFiles) {
      const remoteOid = remoteOidByPath.get(filePath);
      const upstreamHash = hashContent(upstreamContent);
      const localContent = localFiles.get(filePath);
      const localOid = localContent
        ? await computeBlobOidForContent(localContent)
        : null;
      const lastSyncedOid = cachedPaths[filePath] ?? null;

      if (remoteOid && localOid === remoteOid) {
        skippedFiles.push(filePath);
        continue;
      }
      if (localContent !== undefined && upstreamHash === hashContent(localContent)) {
        skippedFiles.push(filePath);
        continue;
      }

      const localUnchanged =
        localContent === undefined ||
        localOid === lastSyncedOid ||
        lastSyncedOid === null;

      if (!localUnchanged && remoteOid && localOid !== remoteOid) {
        conflictFiles.push(filePath);
        continue;
      }

      const written = await appService.writeAppFile(trimmed, filePath, upstreamContent);
      if (written) {
        updatedFiles.push(filePath);
      } else {
        skippedFiles.push(filePath);
      }
    }

    if (updatedFiles.length > 0 || head.commitSha) {
      await applyAckedBlobOids(
        trimmed,
        head.files.map((file) => ({ path: file.path, blobOid: file.blobOid })),
      );
    }

    if (updatedFiles.length > 0) {
      console.log(
        `[PullAppCode] ${trimmed}: updated ${updatedFiles.length} file(s) from per-app repo @ ${head.commitSha.slice(0, 7)}`,
      );
    }

    timer.mark(`merge(updated=${updatedFiles.length})`);
    timer.logIfSlow(`PullAppCode app=${trimmed}`, 500);

    if (conflictFiles.length === 0) {
      await writeAppRepoCommitCursor(trimmed, head.commitSha);
    }

    return {
      appId: trimmed,
      commitSha: head.commitSha,
      updatedFiles,
      conflictFiles,
      skippedFiles,
    };
  } finally {
    await cleanup();
  }
}

/** Pull per-app repo into $PAPR_HOME when a remote writer commit lands (cloud agent, other device). */
export async function pullDesktopAppOnRemoteCommit(input: {
  appId: string;
  commitSha: string;
}): Promise<void> {
  const sync = getCloudSyncService();
  if (!sync) {
    return;
  }

  if (await appNeedsOrderedFlushAsync(sync, input.appId)) {
    console.log(
      `[AppRepoRevisionSubscriber] Skipped desktop pull for ${input.appId} — local changes pending upload`,
    );
    return;
  }

  let token: string | null = null;
  try {
    token = await sync.ensureFreshToken();
  } catch {
    return;
  }

  const result = await pullAppCodeFromRepo(input.appId, { token });
  if (result.skipped && result.reason) {
    console.log(
      `[AppRepoRevisionSubscriber] Desktop pull skipped for ${input.appId}: ${result.reason.slice(0, 80)}`,
    );
    return;
  }

  if (result.updatedFiles.length > 0) {
    console.log(
      `[AppRepoRevisionSubscriber] Pulled ${result.updatedFiles.length} file(s) for ${input.appId} @ ${input.commitSha.slice(0, 7)}`,
    );
  }
  if (result.conflictFiles.length > 0) {
    console.warn(
      `[AppRepoRevisionSubscriber] ${result.conflictFiles.length} file conflict(s) pulling ${input.appId} — resolve locally or upload`,
    );
  }
}

/** True when local file OID differs from last acked remote OID (cloud may be ahead). */
export async function appRepoMayHaveRemoteUpdates(appId: string): Promise<boolean> {
  try {
    const head = await fetchAppRepoHead(appId, { seedOidCache: false });
    return !(await isLocalAppCodeAtRemoteHead(appId, head));
  } catch {
    return false;
  }
}
