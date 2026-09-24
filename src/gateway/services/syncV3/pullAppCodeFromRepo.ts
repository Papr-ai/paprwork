/**
 * Pull app source from the Sync V3 per-app GitHub repo into $PAPR_HOME/apps/{appId}/.
 * Schema-owner migrations (databases/{slug}/migrations/) hydrate into
 * $PAPR_HOME/data/databases/{slug}/migrations/ — the registry apply path.
 * Used by Get updates (per-app) — replaces legacy namespace git for app code.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprAppsRoot, getPaprRoot } from "../../../core/utils/paprRoot.js";
import {
  readActiveAppWorkspaceScope,
  repairPulledMetadataWorkspaceScope,
} from "../../../core/utils/appWorkspaceScope.js";
import { writeCloudAppMetadataFile } from "../cloudAppMetadataFile.js";
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
import {
  applyRegistryMigrationsAfterPull,
  hydrateAppFolderSchemaMigrationsToRegistry,
  persistPulledSchemaMigration,
} from "./syncPulledSchemaOwnerMigrations.js";

export interface PullAppCodeFromRepoResult {
  appId: string;
  commitSha: string | null;
  updatedFiles: string[];
  /** Registry-relative paths under data/databases/{slug}/migrations/ */
  registryMigrationsCopied: string[];
  conflictFiles: string[];
  skippedFiles: string[];
  /** Keep mine: conflicting files where the local version was kept on purpose. */
  keptLocalFiles?: string[];
  /** True when conflicts held the whole update back — nothing was written. */
  heldForConflicts?: boolean;
  skipped?: boolean;
  reason?: string;
}

/**
 * How to handle files both sides changed.
 * - hold (default): all-or-nothing — if any file conflicts, write NOTHING
 *   (no code, no migrations) and report conflictFiles for a user decision.
 * - take_theirs: overwrite conflicting local files with the remote version.
 * - keep_mine: keep local conflicting files, apply the rest of the update,
 *   and accept the remote baseline so a later publish carries your version.
 */
export type PullConflictResolution = "hold" | "take_theirs" | "keep_mine";

type PlannedFile =
  | { action: "skip"; filePath: string }
  | { action: "conflict"; filePath: string; content: string; isMigration: boolean }
  | { action: "write"; filePath: string; content: string; isMigration: boolean };

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
  options: {
    token: string | null;
    allowRecentSkip?: boolean;
    /** Manual Get updates / post-approve: cloud wins over stale local-upload fingerprints. */
    preferCloudOverLocal?: boolean;
    resolution?: PullConflictResolution;
  },
): Promise<PullAppCodeFromRepoResult> {
  const { PhaseTimer } = await import("../../utils/phaseTiming.js");
  const timer = new PhaseTimer();
  const trimmed = appId.trim();
  const empty: PullAppCodeFromRepoResult = {
    appId: trimmed,
    commitSha: null,
    updatedFiles: [],
    registryMigrationsCopied: [],
    conflictFiles: [],
    skippedFiles: [],
  };

  if (!trimmed) {
    return { ...empty, skipped: true, reason: "appId required" };
  }

  const sync = getCloudSyncService();
  const pendingOrderedFlush =
    sync !== null && (await appNeedsOrderedFlushAsync(sync, trimmed));
  // Automatic pulls stop when local looks dirty. Manual Get updates may proceed
  // only after we verify the writer HEAD is ahead of local ack (see fetchHead).
  if (pendingOrderedFlush && !options.preferCloudOverLocal) {
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

  if (pendingOrderedFlush && options.preferCloudOverLocal) {
    console.log(
      `[PullAppCode] ${trimmed}: remote writer HEAD is ahead of local ack — applying cloud (per-file conflicts preserved)`,
    );
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
    const registryMigrationsCopied: string[] = [];
    const conflictFiles: string[] = [];
    const skippedFiles: string[] = [];
    let metadataScopeRepair: ReturnType<
      typeof repairPulledMetadataWorkspaceScope
    > | null = null;

    // Phase 1 — classify every file without touching disk.
    const plan: PlannedFile[] = [];
    for (const [filePath, upstreamContent] of upstreamFiles) {
      const remoteOid = remoteOidByPath.get(filePath);
      const lastSyncedOid = cachedPaths[filePath] ?? null;

      const migrationOutcome = await persistPulledSchemaMigration({
        appId: trimmed,
        repoPath: filePath,
        content: upstreamContent,
        remoteOid,
        lastSyncedOid,
        dryRun: true,
      });
      if (migrationOutcome.kind === "written") {
        plan.push({ action: "write", filePath, content: upstreamContent, isMigration: true });
        continue;
      }
      if (migrationOutcome.kind === "conflict") {
        plan.push({ action: "conflict", filePath, content: upstreamContent, isMigration: true });
        continue;
      }
      if (migrationOutcome.kind === "unchanged" || migrationOutcome.kind === "skipped") {
        plan.push({ action: "skip", filePath });
        continue;
      }

      const upstreamHash = hashContent(upstreamContent);
      const localContent = localFiles.get(filePath);
      const localOid = localContent
        ? await computeBlobOidForContent(localContent)
        : null;

      if (remoteOid && localOid === remoteOid) {
        plan.push({ action: "skip", filePath });
        continue;
      }
      if (localContent !== undefined && upstreamHash === hashContent(localContent)) {
        plan.push({ action: "skip", filePath });
        continue;
      }

      const localUnchanged =
        localContent === undefined ||
        (lastSyncedOid !== null && localOid === lastSyncedOid);

      if (!localUnchanged && remoteOid && localOid !== remoteOid) {
        plan.push({ action: "conflict", filePath, content: upstreamContent, isMigration: false });
        continue;
      }
      plan.push({ action: "write", filePath, content: upstreamContent, isMigration: false });
    }

    const resolution = options.resolution ?? "hold";
    const planned = plan.filter((f) => f.action === "conflict").map((f) => f.filePath);

    // All-or-nothing: a conflict holds the WHOLE update (code + migrations)
    // so the user never runs half of someone else's change.
    if (planned.length > 0 && resolution === "hold") {
      timer.logIfSlow(`PullAppCode held app=${trimmed}`, 200);
      return {
        ...empty,
        commitSha: head.commitSha,
        conflictFiles: planned,
        heldForConflicts: true,
      };
    }

    // Phase 2 — apply.
    const keptLocalFiles: string[] = [];
    for (const item of plan) {
      if (item.action === "skip") {
        skippedFiles.push(item.filePath);
        continue;
      }
      if (item.action === "conflict" && resolution === "keep_mine") {
        keptLocalFiles.push(item.filePath);
        skippedFiles.push(item.filePath);
        continue;
      }

      if (item.isMigration) {
        const outcome = await persistPulledSchemaMigration({
          appId: trimmed,
          repoPath: item.filePath,
          content: item.content,
          remoteOid: remoteOidByPath.get(item.filePath),
          lastSyncedOid: cachedPaths[item.filePath] ?? null,
          overwrite: item.action === "conflict",
        });
        if (outcome.kind === "written") {
          registryMigrationsCopied.push(outcome.registryRelativePath);
          updatedFiles.push(item.filePath);
        } else {
          skippedFiles.push(item.filePath);
        }
        continue;
      }

      let contentToWrite = item.content;
      if (item.filePath === "metadata.json") {
        const localApp = await appService.getApp(trimmed);
        const repair = repairPulledMetadataWorkspaceScope(
          item.content,
          {
            organizationId: localApp?.organizationId,
            namespaceId: localApp?.namespaceId,
          },
          readActiveAppWorkspaceScope(),
        );
        contentToWrite = repair.content;
        if (repair.repaired) {
          metadataScopeRepair = repair;
        }
      }

      const written = await appService.writeAppFile(trimmed, item.filePath, contentToWrite);
      if (written) {
        updatedFiles.push(item.filePath);
      } else {
        skippedFiles.push(item.filePath);
      }
    }

    if (metadataScopeRepair?.appliedScope) {
      const scope = metadataScopeRepair.appliedScope;
      const localApp = await appService.getApp(trimmed);
      if (
        localApp &&
        (localApp.organizationId !== scope.organizationId ||
          localApp.namespaceId !== scope.namespaceId)
      ) {
        await appService.updateApp(trimmed, {
          organizationId: scope.organizationId,
          namespaceId: scope.namespaceId,
        });
        console.log(
          `[PullAppCode] ${trimmed}: repaired apps.json workspace scope → ${scope.organizationId}/${scope.namespaceId}`,
        );
      } else {
        await writeCloudAppMetadataFile(getPaprRoot(), trimmed).catch((err: unknown) => {
          console.warn(
            `[PullAppCode] Failed to rewrite metadata.json for ${trimmed}:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    }

    if (updatedFiles.length > 0 || head.commitSha) {
      await applyAckedBlobOids(
        trimmed,
        head.files.map((file) => ({ path: file.path, blobOid: file.blobOid })),
      );
    }

    if (updatedFiles.length > 0) {
      const migrationNote =
        registryMigrationsCopied.length > 0
          ? ` (${registryMigrationsCopied.length} registry migration(s))`
          : "";
      console.log(
        `[PullAppCode] ${trimmed}: updated ${updatedFiles.length} file(s)${migrationNote} from per-app repo @ ${head.commitSha.slice(0, 7)}`,
      );
    }

    timer.mark(`merge(updated=${updatedFiles.length})`);
    timer.logIfSlow(`PullAppCode app=${trimmed}`, 500);

    if (conflictFiles.length === 0) {
      await writeAppRepoCommitCursor(trimmed, head.commitSha);
    }

    const hydratedFromAppTree = await hydrateAppFolderSchemaMigrationsToRegistry({
      appId: trimmed,
    });
    for (const registryRelativePath of hydratedFromAppTree.copied) {
      registryMigrationsCopied.push(registryRelativePath);
    }

    return {
      appId: trimmed,
      commitSha: head.commitSha,
      updatedFiles,
      registryMigrationsCopied,
      conflictFiles,
      skippedFiles,
      ...(keptLocalFiles.length > 0 ? { keptLocalFiles } : {}),
    };
  } finally {
    await cleanup();
  }
}

export interface DesktopRemoteCommitPullOutcome {
  /** True only when local code actually reached the remote commit (or already was there). */
  pulled: boolean;
  /** Why the update is still waiting — shown on the share bar chip. */
  waitingReason?: string;
  conflictFiles?: string[];
}

/** Pull per-app repo into $PAPR_HOME when a remote writer commit lands (cloud agent, other device). */
export async function pullDesktopAppOnRemoteCommit(input: {
  appId: string;
  commitSha: string;
}): Promise<DesktopRemoteCommitPullOutcome> {
  const sync = getCloudSyncService();
  if (!sync) {
    return { pulled: false, waitingReason: "cloud sync unavailable" };
  }

  if (await appNeedsOrderedFlushAsync(sync, input.appId)) {
    console.log(
      `[AppRepoRevisionSubscriber] Deferred desktop pull for ${input.appId} — local changes pending upload`,
    );
    return { pulled: false, waitingReason: "local changes pending upload" };
  }

  let token: string | null = null;
  try {
    token = await sync.ensureFreshToken();
  } catch {
    return { pulled: false, waitingReason: "cloud login required" };
  }

  // A new commit event means the "recently verified" cursor is stale by
  // definition — always check the remote head.
  const result = await pullAppCodeFromRepo(input.appId, { token, allowRecentSkip: false });
  if (result.skipped && result.reason) {
    console.log(
      `[AppRepoRevisionSubscriber] Desktop pull skipped for ${input.appId}: ${result.reason.slice(0, 80)}`,
    );
    return result.reason === "already at remote head"
      ? { pulled: true }
      : { pulled: false, waitingReason: result.reason };
  }

  if (result.conflictFiles.length === 0) {
    try {
      const applied = await applyRegistryMigrationsAfterPull(input.appId);
      if (applied.length > 0) {
        console.log(
          `[AppRepoRevisionSubscriber] Applied registry migrations for ${input.appId}: ${applied.join(", ")}`,
        );
      }
    } catch (error) {
      console.warn(
        `[AppRepoRevisionSubscriber] Registry migration apply failed for ${input.appId}:`,
        (error as Error).message,
      );
    }
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
    return {
      pulled: false,
      waitingReason: "conflicts with your edits",
      conflictFiles: result.conflictFiles,
    };
  }
  return { pulled: true };
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
