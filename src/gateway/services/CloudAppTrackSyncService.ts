/**
 * Upstream sync for track-mode cloud installs.
 */

import { promises as fs } from "node:fs";
import { getPaprAppsRoot } from "../../core/utils/paprRoot.js";
import * as path from "node:path";

import type { CloudAppLineageFile } from "../../core/types/cloudAppLineage.js";
import {
  parseCloudAppLineageFile,
  serializeCloudAppLineageFile,
} from "../../core/utils/cloudAppLineage.js";
import { fileContentHash } from "../utils/fileContentHash.js";
import { ephemeralGitEnv } from "../utils/ephemeralGitEnv.js";
import {
  cloneCloudAppSource,
  linkedJobRepoRelativeDir,
} from "./cloudSync/cloudGitClone.js";
import {
  mergeFileContents,
  readFilesAtCommit,
  readHeadCommit,
  resolveBaseCommit,
} from "./cloudSync/threeWayMerge.js";
import { dataSourcesForPull, isLocalScratchPath } from "./cloudSync/proposalFileMerge.js";
import { hashBlobContent } from "./syncV3/computeParentHash.js";
import { resolveAppDependentJobIds } from "./cloudSync/resolveAppDependentJobs.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import {
  CLOUD_LINEAGE_FILENAME,
  getCloudAppLineageService,
} from "./CloudAppLineageService.js";
import {
  getCloudAppInstallService,
  type CloudAppInstallInput,
} from "./CloudAppInstallService.js";
import { getAppService } from "./AppService.js";
import { decideTrackPullAction } from "./cloudSync/trackPullOnPublishLogic.js";
import { fetchPublishedAppRevision } from "./cloudSync/trackUpstreamRevision.js";
import {
  hasMetadataChanges,
  mergeTrackedMetadata,
  metadataProposalFromLocal,
  proposableMetadataHash,
  type MetadataBaseline,
} from "./cloudSync/contributeMetadataFields.js";

export interface TrackSyncResult {
  appId: string;
  updatedFiles: string[];
  /** Files where both sides changed different lines; combined automatically. */
  mergedFiles?: string[];
  conflictFiles: string[];
  skippedFiles: string[];
  /** Upstream files that could not be written locally. When non-empty the
   *  base commit and snapshot do not advance for them — the update is not
   *  counted as applied, so the next Get updates retries. */
  failedFiles?: string[];
  /** Overlapping files resolved to the publisher's version on request. */
  takenTheirsFiles?: string[];
  /** dryRun: everything the update brings (status panel list). Nothing written. */
  incoming?: Array<{ path: string; change: "added" | "edited"; merged?: boolean; conflict?: boolean }>;
  lastSyncedAt: string;
  upstreamRevision?: string | null;
}

export interface TrackPullOnPublishResult {
  appId: string;
  action: "synced" | "skipped" | "error";
  upstreamRevision?: string | null;
  liveRevision?: string | null;
  updatedFiles?: string[];
  conflictFiles?: string[];
  error?: string;
}

function hashContent(content: string): string {
  return fileContentHash(content);
}

async function collectLocalFiles(appDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(dir: string, base: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === CLOUD_LINEAGE_FILENAME) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, base);
        continue;
      }
      const rel = path.relative(base, full).replace(/\\/g, "/");
      files.set(rel, await fs.readFile(full, "utf8"));
    }
  }
  await walk(appDir, appDir);
  return files;
}

/** Text files of a job folder, minus run output (data/, logs/, *.db, caches). */
async function collectJobSourceFiles(jobDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(jobDir, full).replace(/\\/g, "/");
      if (isLocalScratchPath(rel, { job: true })) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.set(rel, await fs.readFile(full, "utf8"));
      }
    }
  }
  await walk(jobDir);
  return files;
}

async function readLineageFile(appId: string, appsDir: string): Promise<CloudAppLineageFile | null> {
  try {
    const raw = await fs.readFile(
      path.join(appsDir, appId, CLOUD_LINEAGE_FILENAME),
      "utf8",
    );
    return parseCloudAppLineageFile(raw);
  } catch {
    return null;
  }
}

async function writeLineageFile(
  appId: string,
  appsDir: string,
  lineage: CloudAppLineageFile,
): Promise<void> {
  await fs.writeFile(
    path.join(appsDir, appId, CLOUD_LINEAGE_FILENAME),
    serializeCloudAppLineageFile(lineage),
    "utf8",
  );
}

/**
 * Files the platform writes on build, link or install. They always differ from
 * the publisher's copy (different app/db ids, rebuilt bundle), so they are not
 * edits a collaborator made or could propose.
 */
/** Proposed-snapshot key for field-level metadata edits (not a real path). */
export const METADATA_PROPOSAL_KEY = "metadata.json#fields";

const PLATFORM_MANAGED_FILES = new Set([
  "backend/bundle.json",
  "papr-cloud-dependencies.json",
  "linked-databases.json",
  "metadata.json",
  "data-sources.json",
]);

/** Platform files holding this copy's own app/db ids — kept when they differ locally. */
const LOCAL_WIRING_FILES = new Set([
  "linked-databases.json",
  "data-sources.json",
  "papr-cloud-dependencies.json",
  "metadata.json",
]);

export function isCollaboratorEditablePath(rel: string): boolean {
  return (
    !rel.startsWith("dist/") &&
    !rel.startsWith("__papr__/") &&
    !PLATFORM_MANAGED_FILES.has(rel)
  );
}

/**
 * Files whose local content differs from the last synced upstream snapshot.
 * Pure so the "nothing to propose" rule can be tested without git.
 */
export function listLocalEditsAgainstSnapshot(
  localHashes: Map<string, string>,
  snapshot: Record<string, string>,
): string[] {
  const edited: string[] = [];
  for (const [rel, hash] of localHashes) {
    const base = snapshot[rel];
    if (base === undefined || base !== hash) edited.push(rel);
  }
  for (const rel of Object.keys(snapshot)) {
    if (!localHashes.has(rel)) edited.push(rel);
  }
  return edited.sort();
}

export class CloudAppTrackSyncService {
  private readonly fixedAppsDir: string | undefined;

  constructor(appsDir?: string) {
    this.fixedAppsDir = appsDir;
  }

  /**
   * Resolved per call, not at construction: the singleton outlives workspace
   * switches, and a captured path made pulls, detach and local-edit checks
   * read the previous workspace's apps.
   */
  private get appsDir(): string {
    return this.fixedAppsDir ?? getPaprAppsRoot();
  }

  /**
   * Local-only: which files a collaborator changed since the last upstream
   * sync. Drives Propose greying out when there is nothing to send. No
   * snapshot (older installs) means unknown, so callers keep Propose enabled.
   */
  async localEdits(
    appId: string,
  ): Promise<{ known: boolean; files: string[]; unproposed: string[] }> {
    const lineage = await readLineageFile(appId, this.appsDir);
    if (!lineage || lineage.mode !== "track" || !lineage.syncSnapshot) {
      return { known: false, files: [], unproposed: [] };
    }
    const local = await collectLocalFiles(path.join(this.appsDir, appId));
    const hashes = new Map<string, string>();
    for (const [rel, content] of local) hashes.set(rel, hashContent(content));
    // Only compare paths the publisher ships; local-only build output (dist/)
    // and job scratch are not edits the publisher could review.
    const tracked = new Map([...hashes].filter(([rel]) => isCollaboratorEditablePath(rel)));
    const snapshot = Object.fromEntries(
      Object.entries(lineage.syncSnapshot).filter(([rel]) => isCollaboratorEditablePath(rel)),
    );
    const files = listLocalEditsAgainstSnapshot(tracked, snapshot);
    // Edits already sent in a proposal (same content as when proposed) are
    // waiting on the owner, not "unproposed".
    const proposed = lineage.proposedSnapshot ?? {};
    const unproposed = files.filter((rel) => {
      const sent = proposed[rel];
      if (sent === undefined) return true;
      const now = tracked.get(rel);
      return now === undefined ? sent !== "" : now !== sent;
    });
    // metadata.json itself is platform-managed, but deliberate title /
    // description / icon / tag edits are proposable field by field.
    const metaChanges = metadataProposalFromLocal(
      local.get("metadata.json"),
      lineage.metadataBaseline,
    );
    if (hasMetadataChanges(metaChanges)) {
      files.push("metadata.json");
      if (proposed[METADATA_PROPOSAL_KEY] !== proposableMetadataHash(metaChanges)) {
        unproposed.push("metadata.json");
      }
    }
    return { known: true, files, unproposed };
  }

  /** After a proposal is sent: remember the content that went out. */
  /**
   * v5 Detach: stop following the original for good. The copy keeps its code
   * and data; updates, proposals and the origin menu go away. Stored as
   * mode "fork" so every existing linked-only path (pulls, upstream checks,
   * proposals, delete scope) already treats it as the user's own app.
   *
   * A copy on the team's live data can't detach in place: its code would
   * drift from the team's while writing everyone's data. The caller must
   * switch it to its own data first.
   */
  async detach(appId: string): Promise<{ detached: boolean; reason?: "not_linked" | "on_team_data" }> {
    const lineage = await readLineageFile(appId, this.appsDir);
    if (!lineage || lineage.mode !== "track") return { detached: false, reason: "not_linked" };
    const { usesSharedData } = await import("../../core/utils/copyAxes.js");
    if (usesSharedData(lineage)) return { detached: false, reason: "on_team_data" };
    await writeLineageFile(appId, this.appsDir, {
      ...lineage,
      mode: "fork",
      databasePolicy: "forked",
      trackAutoPull: false,
      detachedAt: new Date().toISOString(),
    });
    return { detached: true };
  }

  async recordProposed(appId: string): Promise<void> {
    const lineage = await readLineageFile(appId, this.appsDir);
    if (!lineage || lineage.mode !== "track") return;
    const local = await collectLocalFiles(path.join(this.appsDir, appId));
    const proposedSnapshot: Record<string, string> = {};
    for (const [rel, content] of local) {
      if (isCollaboratorEditablePath(rel)) proposedSnapshot[rel] = hashContent(content);
    }
    // Deleted files: "" marks "sent as deleted".
    for (const rel of Object.keys(lineage.syncSnapshot ?? {})) {
      if (isCollaboratorEditablePath(rel) && !(rel in proposedSnapshot)) proposedSnapshot[rel] = "";
    }
    const metaChanges = metadataProposalFromLocal(
      local.get("metadata.json"),
      lineage.metadataBaseline,
    );
    if (hasMetadataChanges(metaChanges)) {
      proposedSnapshot[METADATA_PROPOSAL_KEY] = proposableMetadataHash(metaChanges);
    }
    await writeLineageFile(appId, this.appsDir, { ...lineage, proposedSnapshot });
  }

  /**
   * Pull the publisher's code. With `discardLocal`, files the collaborator
   * edited are overwritten with upstream instead of kept as conflicts
   * (the ⋯ menu's Discard my edits). Local-only files are left alone.
   */
  async syncTrackApp(
    appId: string,
    options: {
      discardLocal?: boolean;
      /** Per-file choice for overlapping files: theirs overwrites, mine keeps. */
      fileResolutions?: Record<string, "mine" | "theirs">;
      /** Classify only — report what Get updates would do, write nothing. */
      dryRun?: boolean;
    } = {},
  ): Promise<TrackSyncResult> {
    const lineage = await readLineageFile(appId, this.appsDir);
    if (!lineage) {
      throw new Error(`No cloud lineage for app ${appId}`);
    }
    if (lineage.mode !== "track") {
      throw new Error(`App ${appId} is not in track mode`);
    }

    const installInput: CloudAppInstallInput = {
      namespaceId: lineage.source.namespaceId,
      slug: lineage.source.slug,
      mode: "track",
    };

    const installService = getCloudAppInstallService();
    const prepare = await installService.prepareInstall(installInput);
    const env = ephemeralGitEnv();

    const { sourceDir: upstreamDir, repoDir, cleanup } = await cloneCloudAppSource(
      {
        cloneUrl: prepare.cloneUrl,
        token: prepare.token,
        repoPath: prepare.repoPath,
      },
      "papr-track-sync-",
    );

    try {
      // Install rewrote the publisher's app id to ours; do the same to incoming
      // files so updates compare like-for-like and don't reintroduce their id.
      const publisherAppId = prepare.source?.appId;
      const rawUpstream = await collectLocalFiles(upstreamDir);
      const localFiles = await collectLocalFiles(path.join(this.appsDir, appId));
      // A copy on its own data got fresh database ids at install; translate
      // them too, or an update re-wires the copy to the publisher's databases.
      const { usesSharedData: onTeamData } = await import("../../core/utils/copyAxes.js");
      const ownDb = await import("./cloudSync/ownDataDbIdMap.js");
      const dbToLocal = onTeamData(lineage)
        ? new Map<string, string>()
        : ownDb.inferOwnDataDbIdMap(localFiles.get("data-sources.json"), rawUpstream.get("data-sources.json"));
      const dbToPublisher = ownDb.invertDbIdMap(dbToLocal);
      const upstreamFiles = new Map(
        [...rawUpstream].map(([rel, content]) => [
          rel,
          ownDb.remapDbIdsInContent(
            publisherAppId && publisherAppId !== appId
              ? content.split(publisherAppId).join(appId)
              : content,
            dbToLocal,
          ),
        ]),
      );
      const snapshot = lineage.syncSnapshot ?? {};

      // The commit this copy is based on, so files both sides touched can be
      // merged line by line instead of reported as whole-file conflicts.
      const upstreamHead = await readHeadCommit(repoDir, env);
      const appRepoPrefix = path
        .relative(repoDir, upstreamDir)
        .replace(/\\/g, "/");
      const toPublisherIds = (content: string) =>
        ownDb.remapDbIdsInContent(
          publisherAppId && publisherAppId !== appId
            ? content.split(appId).join(publisherAppId)
            : content,
          dbToPublisher,
        );
      const toLocalIds = (content: string) =>
        ownDb.remapDbIdsInContent(
          publisherAppId && publisherAppId !== appId
            ? content.split(publisherAppId).join(appId)
            : content,
          dbToLocal,
        );
      const base = await resolveBaseCommit(
        repoDir,
        lineage.baseCommit,
        async () => {
          const oids = new Map<string, string>();
          for (const [rel, content] of localFiles) {
            if (!isCollaboratorEditablePath(rel) || rel === "README.md" || rel.startsWith("jobs/")) continue;
            oids.set(appRepoPrefix ? `${appRepoPrefix}/${rel}` : rel, hashBlobContent(toPublisherIds(content)));
          }
          return oids;
        },
        env,
      ).catch(() => null);
      const baseFiles = base
        ? new Map(
            [
              ...(await readFilesAtCommit(
                repoDir,
                base.sha,
                appRepoPrefix || ".",
                env,
                new Map([...localFiles].map(([rel, c]) => [rel, toPublisherIds(c)])),
              )),
            ].map(([rel, c]) => [rel, toLocalIds(c)]),
          )
        : new Map<string, string>();
      const mergedFiles: string[] = [];
      const takenTheirsFiles: string[] = [];
      const incoming: NonNullable<TrackSyncResult["incoming"]> = [];
      const dryRun = options.dryRun === true;
      const write = async (rel: string, content: string): Promise<boolean> =>
        dryRun ? true : Boolean(await appService.writeAppFile(appId, rel, content));

      const appService = getAppService();
      // Every write below goes through AppService, which answers false for an
      // app it cannot see. Fail up front instead of "applying" an update that
      // wrote nothing.
      if (!(await appService.getApp(appId))) {
        throw new Error(
          `Can't get updates: app ${appId} isn't available in this workspace`,
        );
      }
      const failedFiles: string[] = [];
      const updatedFiles: string[] = [];
      const conflictFiles: string[] = [];
      const skippedFiles: string[] = [];

      let nextMetadataBaseline: MetadataBaseline | undefined = lineage.metadataBaseline;
      let nextMetadataUpstream: MetadataBaseline | undefined =
        lineage.metadataUpstreamBaseline;
      for (const [filename, upstreamContent] of upstreamFiles) {
        if (filename === "metadata.json" && lineage.metadataBaseline) {
          const localContent = localFiles.get(filename);
          const merged = mergeTrackedMetadata(
            localContent,
            upstreamContent,
            {
              local: lineage.metadataBaseline,
              upstream: lineage.metadataUpstreamBaseline,
            },
            { discardLocal: options.discardLocal, copyAppId: appId },
          );
          if (!merged) {
            skippedFiles.push(filename);
            continue;
          }
          nextMetadataBaseline = merged.baseline;
          nextMetadataUpstream = merged.upstreamBaseline;
          if (localContent !== undefined && hashContent(localContent) === hashContent(merged.content)) {
            skippedFiles.push(filename);
            continue;
          }
          const written = await write(filename, merged.content);
          (written ? updatedFiles : failedFiles).push(filename);
          continue;
        }
        const upstreamHash = hashContent(upstreamContent);
        const localContent = localFiles.get(filename);
        const localHash = localContent !== undefined ? hashContent(localContent) : null;
        const snapshotHash = snapshot[filename];

        if (localHash === upstreamHash) {
          skippedFiles.push(filename);
          continue;
        }

        const localUnchanged =
          localHash === null ||
          localHash === snapshotHash ||
          snapshotHash === undefined;

        // Platform-written files are never a collaborator's edit, so they can't
        // conflict. Generated output (dist/, __papr__/, backend bundle) follows
        // the publisher; id-bearing wiring files that differ locally keep the
        // local copy — the linked-resource install below rewrites them.
        if (filename === "data-sources.json" && localContent !== undefined && !options.discardLocal) {
          // Keep this machine's links (and dbPaths); add any the publisher added.
          const next = dataSourcesForPull(localContent, upstreamContent);
          if (next === null) {
            skippedFiles.push(filename);
          } else {
            const written = await write(filename, next);
            (written ? updatedFiles : failedFiles).push(filename);
          }
          continue;
        }
        if (!isCollaboratorEditablePath(filename)) {
          if (LOCAL_WIRING_FILES.has(filename) && !localUnchanged && !options.discardLocal) {
            skippedFiles.push(filename);
            continue;
          }
        } else if (!localUnchanged && localHash !== upstreamHash && !options.discardLocal) {
          const baseContent = baseFiles.get(filename);
          if (localContent !== undefined && baseContent !== undefined) {
            const merged = await mergeFileContents(localContent, baseContent, upstreamContent);
            if (merged.clean && merged.content !== undefined) {
              if (merged.content === localContent) {
                skippedFiles.push(filename);
                continue;
              }
              const written = await write(filename, merged.content);
              (written ? mergedFiles : failedFiles).push(filename);
              continue;
            }
          }
          if (options.fileResolutions?.[filename] === "theirs") {
            const written = await write(filename, upstreamContent);
            (written ? takenTheirsFiles : failedFiles).push(filename);
            continue;
          }
          conflictFiles.push(filename);
          continue;
        }

        const written = await write(filename, upstreamContent);
        (written ? updatedFiles : failedFiles).push(filename);
      }

      if (dryRun) {
        const mark = (list: string[], extra: { merged?: boolean; conflict?: boolean }) => {
          for (const rel of list) {
            incoming.push({ path: rel, change: localFiles.has(rel) ? "edited" : "added", ...extra });
          }
        };
        mark(updatedFiles, {});
        mark(mergedFiles, { merged: true });
        mark(conflictFiles, { conflict: true });
        return {
          appId,
          updatedFiles,
          mergedFiles,
          conflictFiles,
          skippedFiles,
          incoming,
          lastSyncedAt: lineage.lastSyncedAt ?? new Date().toISOString(),
        };
      }

      const nextSnapshot: Record<string, string> = { ...snapshot };
      for (const [filename, content] of upstreamFiles) {
        // A file that failed to write still holds the old content locally.
        if (failedFiles.includes(filename)) continue;
        nextSnapshot[filename] = hashContent(content);
      }

      const lastSyncedAt = new Date().toISOString();
      const upstreamRevision = await fetchPublishedAppRevision(
        lineage.source.namespaceId,
        lineage.source.slug,
      );
      await writeLineageFile(appId, this.appsDir, {
        ...lineage,
        schemaVersion: lineage.schemaVersion ?? "1.2.0",
        lastSyncedAt,
        syncSnapshot: nextSnapshot,
        // Advance the base only when everything applied; with conflicts the
        // kept local files are still based on the old commit.
        ...(conflictFiles.length === 0 && failedFiles.length === 0 && upstreamHead
          ? { baseCommit: upstreamHead }
          : base
            ? { baseCommit: base.sha }
            : {}),
        ...(upstreamRevision ? { upstreamRevision } : {}),
        ...(nextMetadataBaseline ? { metadataBaseline: nextMetadataBaseline } : {}),
        ...(nextMetadataUpstream ? { metadataUpstreamBaseline: nextMetadataUpstream } : {}),
      });

      // Linked-job install replaces job folders wholesale with the publisher's
      // copy. Remember the collaborator's job code first so edits survive.
      const paprRoot = getPaprRoot();
      const jobIdsBefore = resolveAppDependentJobIds(paprRoot, appId);
      const localJobFiles = new Map<string, Map<string, string>>();
      if (!options.discardLocal) {
        for (const jobId of jobIdsBefore) {
          localJobFiles.set(jobId, await collectJobSourceFiles(path.join(paprRoot, "Jobs", jobId)));
        }
      }

      const sharedDatabase =
        lineage.databasePolicy === "shared" ||
        (lineage.databasePolicy === undefined && lineage.mode === "track");

      try {
        const {
          installCloudAppLinkedResources,
          finalizePortableCloudAppResources,
        } = await import("./cloudAppLinkedResourcesInstall.js");
        const linked = await installCloudAppLinkedResources({
          repoDir,
          repoAppDir: upstreamDir,
          publisherAppId: lineage.source.appId,
          localAppId: appId,
          env,
          // Either way the copy keeps the databases it already has: the team's
          // (shared) or its own (fork_empty). A full resource sync here merged
          // the publisher's registry and linked the copy to the publisher's
          // databases next to its own (Community Get updates, 2026-10-05).
          syncScope: "jobs_and_code" as const,
          skipReplicaPrep: true,
          installDbPolicy: sharedDatabase ? ("shared_primary" as const) : ("fork_empty" as const),
        });
        if (linked.copiedJobIds.length > 0) {
          console.log(
            `[CloudTrackSync] Updated ${linked.copiedJobIds.length} linked job(s) for ${appId}`,
          );
        }
        await finalizePortableCloudAppResources();
        await this.restoreJobEdits({
          localJobFiles,
          baseSha: base?.sha ?? null,
          repoDir,
          repoPath: prepare.repoPath,
          env,
          toLocalIds,
          mergedFiles,
          conflictFiles,
        });
        const { bootstrapInstalledAppDatabases, pullTrackSharedAppDatabase } =
          await import("./cloudAppInstallBootstrap.js");
        const bootstrap = sharedDatabase
          ? await pullTrackSharedAppDatabase(appId)
          : await bootstrapInstalledAppDatabases(appId);
        if (bootstrap.errors.length > 0) {
          console.warn(
            `[CloudTrackSync] Database bootstrap errors for ${appId}:`,
            bootstrap.errors.slice(0, 2).join("; "),
          );
        } else if (bootstrap.warnings.length > 0) {
          console.warn(
            `[CloudTrackSync] Database bootstrap warnings for ${appId}:`,
            bootstrap.warnings.slice(0, 2).join(" | "),
          );
        }
      } catch (linkedErr) {
        console.warn(
          `[CloudTrackSync] Linked resource sync failed for ${appId}:`,
          (linkedErr as Error).message.slice(0, 160),
        );
      }

      if (conflictFiles.some((f) => f.startsWith("jobs/")) && base) {
        // A job edit conflicted after the base was advanced above: put it back.
        const latest = await readLineageFile(appId, this.appsDir);
        if (latest && latest.baseCommit !== base.sha) {
          await writeLineageFile(appId, this.appsDir, { ...latest, baseCommit: base.sha });
        }
      }

      return {
        appId,
        updatedFiles,
        mergedFiles,
        conflictFiles,
        skippedFiles,
        ...(takenTheirsFiles.length > 0 ? { takenTheirsFiles } : {}),
        ...(failedFiles.length > 0 ? { failedFiles } : {}),
        lastSyncedAt,
        upstreamRevision,
      };
    } finally {
      await cleanup();
    }
  }

  /**
   * After the publisher's job folders were copied in: put back the
   * collaborator's job edits, merged line by line with the publisher's
   * changes. Overlaps keep the local version and are reported as conflicts.
   */
  private async restoreJobEdits(input: {
    localJobFiles: Map<string, Map<string, string>>;
    baseSha: string | null;
    repoDir: string;
    repoPath: string;
    env: NodeJS.ProcessEnv;
    toLocalIds: (content: string) => string;
    mergedFiles: string[];
    conflictFiles: string[];
  }): Promise<void> {
    const paprRoot = getPaprRoot();
    for (const [jobId, before] of input.localJobFiles) {
      const jobDir = path.join(paprRoot, "Jobs", jobId);
      const after = await collectJobSourceFiles(jobDir);
      const base = input.baseSha
        ? await readFilesAtCommit(
            input.repoDir,
            input.baseSha,
            linkedJobRepoRelativeDir(input.repoPath, jobId),
            input.env,
          )
        : new Map<string, string>();
      for (const [rel, local] of before) {
        // job.json carries per-machine fields (schedule on/off, keys); the
        // installer already merged it.
        if (rel === "job.json") continue;
        const upstream = after.get(rel);
        if (upstream === local) continue;
        const baseRaw = base.get(rel);
        const baseContent = baseRaw === undefined ? undefined : input.toLocalIds(baseRaw);
        if (baseContent !== undefined && local === baseContent) continue; // not edited
        const label = `jobs/${jobId}/${rel}`;
        let next: string | null = null;
        if (upstream === undefined || baseContent === undefined) {
          next = local; // local-only file, or no base: keep the collaborator's
        } else {
          const merged = await mergeFileContents(local, baseContent, upstream);
          if (merged.clean && merged.content !== undefined) {
            next = merged.content;
            if (upstream !== baseContent) input.mergedFiles.push(label);
          } else {
            next = local;
            input.conflictFiles.push(label);
          }
        }
        if (next !== undefined && next !== upstream) {
          await fs.mkdir(path.dirname(path.join(jobDir, rel)), { recursive: true });
          await fs.writeFile(path.join(jobDir, rel), next, "utf8");
        }
      }
    }
  }

  /**
   * Poll published revisions and auto-pull track installs when the owner ships.
   */
  async pullTrackAppsOnPublish(): Promise<TrackPullOnPublishResult[]> {
    const index = await getCloudAppLineageService(this.appsDir).buildIndex();
    const results: TrackPullOnPublishResult[] = [];

    for (const [appId, entry] of Object.entries(index.byAppId)) {
      if (entry.mode !== "track") {
        continue;
      }

      const lineage = await readLineageFile(appId, this.appsDir);
      if (!lineage) {
        continue;
      }

      const liveRevision = await fetchPublishedAppRevision(
        lineage.source.namespaceId,
        lineage.source.slug,
      );

      const decision = decideTrackPullAction({
        mode: entry.mode,
        lineage,
        liveRevision,
      });

      if (decision.action === "skip") {
        results.push({
          appId,
          action: "skipped",
          upstreamRevision: lineage.upstreamRevision ?? null,
          liveRevision,
        });
        continue;
      }

      try {
        const syncResult = await this.syncTrackApp(appId);
        results.push({
          appId,
          action: "synced",
          upstreamRevision: syncResult.upstreamRevision ?? liveRevision,
          liveRevision,
          updatedFiles: syncResult.updatedFiles,
          conflictFiles: syncResult.conflictFiles,
        });
        if (syncResult.updatedFiles.length > 0 && liveRevision) {
          console.log(
            `[CloudTrackSync] Auto-pulled ${appId} after publisher revision ${liveRevision.slice(0, 12)}`,
          );
        }
      } catch (err) {
        const message = (err as Error).message.slice(0, 160);
        results.push({
          appId,
          action: "error",
          upstreamRevision: lineage.upstreamRevision ?? null,
          liveRevision,
          error: message,
        });
        console.warn(`[CloudTrackSync] Auto-pull failed for ${appId}:`, message);
      }
    }

    return results;
  }

  async syncAllTrackApps(): Promise<TrackSyncResult[]> {
    const index = await getCloudAppLineageService(this.appsDir).buildIndex();
    const results: TrackSyncResult[] = [];

    for (const [appId, entry] of Object.entries(index.byAppId)) {
      if (entry.mode !== "track") continue;
      try {
        results.push(await this.syncTrackApp(appId));
      } catch (err) {
        console.warn(
          `[CloudTrackSync] Skipped ${appId}:`,
          (err as Error).message.slice(0, 120),
        );
      }
    }

    return results;
  }
}

let instance: CloudAppTrackSyncService | null = null;

export function getCloudAppTrackSyncService(): CloudAppTrackSyncService {
  if (!instance) {
    instance = new CloudAppTrackSyncService();
  }
  return instance;
}
