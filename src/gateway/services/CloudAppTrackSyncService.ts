/**
 * Upstream sync for track-mode cloud installs.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { CloudAppLineageFile } from "../../core/types/cloudAppLineage.js";
import {
  parseCloudAppLineageFile,
  serializeCloudAppLineageFile,
} from "../../core/utils/cloudAppLineage.js";
import { fileContentHash } from "./CloudAppChangeMergeService.js";
import {
  CLOUD_LINEAGE_FILENAME,
  getCloudAppLineageService,
} from "./CloudAppLineageService.js";
import {
  getCloudAppInstallService,
  type CloudAppInstallInput,
} from "./CloudAppInstallService.js";
import { getAppService } from "./AppService.js";

function authCloneUrl(cloneUrl: string, token: string): string {
  const normalized = cloneUrl.replace(/^https:\/\//, "");
  return `https://x-access-token:${token}@${normalized}`;
}

export interface TrackSyncResult {
  appId: string;
  updatedFiles: string[];
  conflictFiles: string[];
  skippedFiles: string[];
  lastSyncedAt: string;
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
    this.appsDir = appsDir ?? path.join(os.homedir(), "Papr", "apps");
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
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "papr-track-sync-"));
    const repoDir = path.join(tempRoot, "repo");

    try {
      const cloneUrl = authCloneUrl(prepare.cloneUrl, prepare.token);
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

      await runGit(
        ["clone", "--filter=blob:none", "--sparse", cloneUrl, repoDir],
        env,
        180_000,
      );
      await runGit(
        ["sparse-checkout", "set", prepare.repoPath.replace(/\\/g, "/")],
        env,
        60_000,
        repoDir,
      );

      const upstreamDir = path.join(repoDir, prepare.repoPath);
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
      await writeLineageFile(appId, this.appsDir, {
        ...lineage,
        schemaVersion: "1.1.0",
        lastSyncedAt,
        syncSnapshot: nextSnapshot,
      });

      return {
        appId,
        updatedFiles,
        conflictFiles,
        skippedFiles,
        lastSyncedAt,
      };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
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

async function runGit(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  cwd?: string,
): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`git timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });
}

let instance: CloudAppTrackSyncService | null = null;

export function getCloudAppTrackSyncService(): CloudAppTrackSyncService {
  if (!instance) {
    instance = new CloudAppTrackSyncService();
  }
  return instance;
}
