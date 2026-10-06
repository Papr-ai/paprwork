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
import { mergeFileContents, runGit } from "../cloudSync/threeWayMerge.js";
import { ephemeralGitEnv } from "../../utils/ephemeralGitEnv.js";
import { fetchAppRepoHead } from "./AppOpsClient.js";
import { MASS_DELETE_THRESHOLD, readSyncManifest, updateSyncManifest } from "./SyncManifest.js";
import { localPathForRepoPath, planRemoteDeletes } from "./syncDeletes.js";
import { writeAppRepoCommitCursor, readAppRepoCommitCursors } from "./appRepoCommittedFanout.js";
import {
  isAppCodeRecentlyVerified,
  isLocalAppCodeAtRemoteHead,
} from "./appRepoHeadSyncCheck.js";
import { ensureAppRepoRecord, fetchAppRepoReadCredentials, getAppRepoRecord } from "./AppRepoClient.js";
import {
  applyAckedBlobOids,
  readOidCache,
  removeCachedPaths,
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
  /** Both sides changed different lines; combined automatically (three-way). */
  mergedFiles?: string[];
  /** Everything the update brings, for the status panel's list (hold + dryRun). */
  incoming?: IncomingFileChange[];
  /** Keep mine: conflicting files where the local version was kept on purpose. */
  keptLocalFiles?: string[];
  /** True when conflicts held the whole update back — nothing was written. */
  heldForConflicts?: boolean;
  /** Files the update removes here (deleted on the web, unchanged here). */
  deleteFiles?: string[];
  /** Files actually removed. */
  deletedFiles?: string[];
  /** More than MASS_DELETE_THRESHOLD removals — held until the user confirms. */
  heldForDeletes?: boolean;
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

/** Per-file choice for an overlapping file. Overrides `resolution` for that path. */
export type PullFileResolution = "mine" | "theirs";

export interface IncomingFileChange {
  path: string;
  change: "added" | "edited" | "removed";
  /** Combined with local edits automatically. */
  merged?: boolean;
  /** Overlaps a local edit — needs a choice. */
  conflict?: boolean;
}

type PlannedFile =
  | { action: "skip"; filePath: string }
  /** Deleted on the web, unchanged here since the last sync. */
  | { action: "delete"; filePath: string }
  | { action: "merge"; filePath: string; content: string; isMigration: false }
  | {
      action: "conflict";
      filePath: string;
      content: string;
      isMigration: boolean;
      /** Deleted on the web, edited here. Theirs = delete; mine = keep (republished). */
      remoteDeleted?: true;
      /** Deleted here, edited on the web. Theirs = restore; mine = keep it deleted. */
      localDeleted?: true;
    }
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

/**
 * Content of the version both sides started from (the last synced blob).
 * Partial clones fetch the blob on demand; any failure means "no base", and
 * the file stays a conflict exactly as before.
 */
async function readBaseBlob(repoDir: string, oid: string | null): Promise<string | null> {
  if (!oid) return null;
  try {
    const { stdout } = await runGit(["cat-file", "blob", oid], {
      cwd: repoDir,
      env: ephemeralGitEnv(),
      timeoutMs: 30_000,
    });
    return stdout;
  } catch {
    return null;
  }
}

function toIncoming(plan: PlannedFile[], localFiles: Map<string, string>): IncomingFileChange[] {
  return plan
    .filter((f) => f.action !== "skip")
    .map((f) => ({
      path: f.filePath,
      change:
        f.action === "delete" || (f.action === "conflict" && f.remoteDeleted)
          ? ("removed" as const)
          : localFiles.has(f.filePath)
            ? ("edited" as const)
            : ("added" as const),
      ...(f.action === "merge" ? { merged: true } : {}),
      ...(f.action === "conflict" ? { conflict: true } : {}),
    }));
}

/** Remove one synced file (app or job). Never a folder, never outside its root. */
async function deleteLocalRepoFile(paprDir: string, appId: string, repoPath: string): Promise<boolean> {
  if (repoPath.split("/").some((part) => part === ".." || part === "")) return false;
  const full = localPathForRepoPath(paprDir, appId, repoPath);
  try {
    const stat = await fs.lstat(full);
    if (!stat.isFile()) return false;
    await fs.rm(full);
    return true;
  } catch {
    return false;
  }
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
    /** Per-file Mine / Theirs for overlapping files (status panel). */
    fileResolutions?: Record<string, PullFileResolution>;
    /** Classify only: report what Get updates would do, write nothing. */
    dryRun?: boolean;
    /** The user confirmed an update that removes more than MASS_DELETE_THRESHOLD files. */
    confirmDeletes?: boolean;
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
  let cloneRepoDir: string;
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
    cloneRepoDir = cloned.repoDir ?? cloned.sourceDir;
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
    const paprDir = getPaprRoot();
    const manifest = await readSyncManifest(trimmed);
    const existsLocally = (repoPath: string) =>
      fs.lstat(localPathForRepoPath(paprDir, trimmed, repoPath)).then(() => true, () => false);

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

      // In the last sync, gone here now: this computer deleted it.
      const baseOid = manifest.files.get(filePath);
      if (localContent === undefined && baseOid && !(await existsLocally(filePath))) {
        if (!remoteOid || remoteOid === baseOid) {
          // Unchanged on the web: keep it deleted; the next publish removes it there.
          plan.push({ action: "skip", filePath });
        } else {
          plan.push({
            action: "conflict",
            filePath,
            content: upstreamContent,
            isMigration: false,
            localDeleted: true,
          });
        }
        continue;
      }

      const localUnchanged =
        localContent === undefined ||
        (lastSyncedOid !== null && localOid === lastSyncedOid);

      if (!localUnchanged && remoteOid && localOid !== remoteOid) {
        // Both sides edited: combine line by line against the last synced
        // version, like git. Only overlapping lines are a real conflict.
        const base = localContent !== undefined
          ? await readBaseBlob(cloneRepoDir, lastSyncedOid)
          : null;
        if (base !== null && localContent !== undefined) {
          const merged = await mergeFileContents(localContent, base, upstreamContent);
          if (merged.clean && merged.content !== undefined) {
            plan.push({ action: "merge", filePath, content: merged.content, isMigration: false });
            continue;
          }
        }
        plan.push({ action: "conflict", filePath, content: upstreamContent, isMigration: false });
        continue;
      }
      plan.push({ action: "write", filePath, content: upstreamContent, isMigration: false });
    }

    // Deleted on the web since our last sync. An empty HEAD listing is never
    // read as "everything was deleted".
    const remotePaths = new Set(head.files.map((file) => file.path));
    const forgottenPaths: string[] = [];
    if (head.files.length > 0) {
      for (const rd of await planRemoteDeletes({ paprDir, appId: trimmed, manifest, remotePaths })) {
        if (rd.action === "delete") {
          plan.push({ action: "delete", filePath: rd.filePath });
        } else if (rd.action === "delete_conflict") {
          plan.push({
            action: "conflict",
            filePath: rd.filePath,
            content: "",
            isMigration: false,
            remoteDeleted: true,
          });
        } else {
          forgottenPaths.push(rd.filePath);
        }
      }
    }
    const plannedDeletes = plan.filter((f) => f.action === "delete").map((f) => f.filePath);
    const deletesNeedConfirm =
      plannedDeletes.length > MASS_DELETE_THRESHOLD && options.confirmDeletes !== true;

    const resolution = options.resolution ?? "hold";
    const fileResolutions = options.fileResolutions ?? {};
    const planned = plan.filter((f) => f.action === "conflict").map((f) => f.filePath);
    const unresolved = planned.filter((p) => !fileResolutions[p]);
    const plannedMerged = plan.filter((f) => f.action === "merge").map((f) => f.filePath);

    if (options.dryRun) {
      return {
        ...empty,
        commitSha: head.commitSha,
        conflictFiles: planned,
        mergedFiles: plannedMerged,
        incoming: toIncoming(plan, localFiles),
        ...(plannedDeletes.length > 0 ? { deleteFiles: plannedDeletes } : {}),
      };
    }

    // Removing many files at once waits for an explicit confirmation, and
    // like a conflict it holds the WHOLE update.
    if (deletesNeedConfirm) {
      return {
        ...empty,
        commitSha: head.commitSha,
        incoming: toIncoming(plan, localFiles),
        deleteFiles: plannedDeletes,
        heldForDeletes: true,
        skipped: true,
        reason: `This update removes ${plannedDeletes.length} files — confirm to apply it`,
      };
    }

    // All-or-nothing: a conflict holds the WHOLE update (code + migrations)
    // so the user never runs half of someone else's change.
    if (unresolved.length > 0 && resolution === "hold") {
      timer.logIfSlow(`PullAppCode held app=${trimmed}`, 200);
      return {
        ...empty,
        commitSha: head.commitSha,
        conflictFiles: planned,
        mergedFiles: plannedMerged,
        incoming: toIncoming(plan, localFiles),
        heldForConflicts: true,
      };
    }

    // Phase 2 — apply.
    const keptLocalFiles: string[] = [];
    const mergedFiles: string[] = [];
    const deletedFiles: string[] = [];
    /** Kept deleted over a web edit: the next publish deletes the web's version. */
    const keepDeletedAt: Array<{ path: string; oid: string }> = [];
    for (const item of plan) {
      if (item.action === "skip") {
        skippedFiles.push(item.filePath);
        continue;
      }
      const choice = item.action === "conflict"
        ? fileResolutions[item.filePath] ?? (resolution === "keep_mine" ? "mine" : "theirs")
        : null;
      if (choice === "mine") {
        keptLocalFiles.push(item.filePath);
        skippedFiles.push(item.filePath);
        const remoteOid = remoteOidByPath.get(item.filePath);
        if (item.action === "conflict" && item.localDeleted && remoteOid) {
          keepDeletedAt.push({ path: item.filePath, oid: remoteOid });
        }
        continue;
      }
      if (item.action === "delete" || (item.action === "conflict" && item.remoteDeleted)) {
        if (await deleteLocalRepoFile(paprDir, trimmed, item.filePath)) {
          deletedFiles.push(item.filePath);
          updatedFiles.push(item.filePath);
        } else {
          skippedFiles.push(item.filePath);
        }
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
        (item.action === "merge" ? mergedFiles : updatedFiles).push(item.filePath);
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
      if (head.files.length > 0) {
        // Paths the web no longer has. A file kept over a web delete then has
        // no cached OID, so the next publish sends it as new.
        await removeCachedPaths(
          trimmed,
          Object.keys(cachedPaths).filter((p) => !remotePaths.has(p)),
        );
      }
      // New merge base: whatever exists on both sides is at the web's version.
      const agreed: Array<{ path: string; oid: string }> = [];
      for (const file of head.files) {
        if (await existsLocally(file.path)) agreed.push({ path: file.path, oid: file.blobOid });
      }
      await updateSyncManifest(trimmed, {
        add: [...agreed, ...keepDeletedAt],
        remove: head.files.length > 0
          ? [...manifest.files.keys()].filter(
              (p) => !remotePaths.has(p),
            )
          : [],
      });
      const { revalidateAppDirty } = await import("./appDirtyState.js");
      await revalidateAppDirty(getPaprRoot(), trimmed);
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

    // db.ts is generated from data-sources.json; rebuild it after every pull so
    // links the publisher added (or a merged proposal brought) are reflected.
    try {
      await appService.ensureAppDbTs(trimmed);
    } catch {
      /* regenerated on the next link / pull */
    }

    const hydratedFromAppTree = await hydrateAppFolderSchemaMigrationsToRegistry({
      appId: trimmed,
    });
    for (const registryRelativePath of hydratedFromAppTree.copied) {
      registryMigrationsCopied.push(registryRelativePath);
    }

    if (deletedFiles.length > 0) {
      console.log(`[PullAppCode] ${trimmed}: removed ${deletedFiles.length} file(s) deleted on the web`);
    }
    void forgottenPaths;

    return {
      appId: trimmed,
      commitSha: head.commitSha,
      updatedFiles,
      registryMigrationsCopied,
      conflictFiles,
      skippedFiles,
      ...(deletedFiles.length > 0 ? { deletedFiles } : {}),
      ...(mergedFiles.length > 0 ? { mergedFiles } : {}),
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
  const { withAppSyncLock } = await import("./appSyncLock.js");
  const result = await withAppSyncLock(input.appId, "remote-commit-pull", () =>
    pullAppCodeFromRepo(input.appId, { token, allowRecentSkip: false }),
  );
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
