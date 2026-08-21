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
import { cloneCloudAppSource } from "./cloudSync/cloudGitClone.js";
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

export interface TrackSyncResult {
  appId: string;
  updatedFiles: string[];
  conflictFiles: string[];
  skippedFiles: string[];
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

export class CloudAppTrackSyncService {
  private readonly appsDir: string;

  constructor(appsDir?: string) {
    this.appsDir = appsDir ?? getPaprAppsRoot();
  }

  async syncTrackApp(appId: string): Promise<TrackSyncResult> {
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
      const upstreamFiles = await collectLocalFiles(upstreamDir);
      const localFiles = await collectLocalFiles(path.join(this.appsDir, appId));
      const snapshot = lineage.syncSnapshot ?? {};

      const appService = getAppService();
      const updatedFiles: string[] = [];
      const conflictFiles: string[] = [];
      const skippedFiles: string[] = [];

      for (const [filename, upstreamContent] of upstreamFiles) {
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

        if (!localUnchanged && localHash !== upstreamHash) {
          conflictFiles.push(filename);
          continue;
        }

        const written = await appService.writeAppFile(appId, filename, upstreamContent);
        if (written) {
          updatedFiles.push(filename);
        } else {
          skippedFiles.push(filename);
        }
      }

      const nextSnapshot: Record<string, string> = { ...snapshot };
      for (const [filename, content] of upstreamFiles) {
        nextSnapshot[filename] = hashContent(content);
      }

      const lastSyncedAt = new Date().toISOString();
      const upstreamRevision = await fetchPublishedAppRevision(
        lineage.source.namespaceId,
        lineage.source.slug,
      );
      await writeLineageFile(appId, this.appsDir, {
        ...lineage,
        schemaVersion: "1.1.0",
        lastSyncedAt,
        syncSnapshot: nextSnapshot,
        ...(upstreamRevision ? { upstreamRevision } : {}),
      });

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
        });
        if (linked.copiedJobIds.length > 0) {
          console.log(
            `[CloudTrackSync] Updated ${linked.copiedJobIds.length} linked job(s) for ${appId}`,
          );
        }
        await finalizePortableCloudAppResources();
        const { bootstrapInstalledAppDatabases } = await import(
          "./cloudAppInstallBootstrap.js"
        );
        const bootstrap = await bootstrapInstalledAppDatabases(appId);
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

      return {
        appId,
        updatedFiles,
        conflictFiles,
        skippedFiles,
        lastSyncedAt,
        upstreamRevision,
      };
    } finally {
      await cleanup();
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
