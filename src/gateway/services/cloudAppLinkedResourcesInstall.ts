/**
 * Install / update jobs and registry entries when cloud-installing or
 * track-syncing a mini-app from the owner's git repo.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getPaprAppsRoot, getPaprRoot } from "../../core/utils/paprRoot.js";
import { parseDataSourcesFile } from "./appDataSources.js";
import {
  jobRelativePath,
  resolveAppDependentJobIds,
} from "./cloudSync/resolveAppDependentJobs.js";
import { syncAppLinkedResourcesToTarget } from "./copyAppToNamespace.js";
import { ephemeralGitEnv } from "../utils/ephemeralGitEnv.js";
import {
  assessCloudInstallHealth,
  promoteBundledAppJobsToRegistry,
} from "./cloudAppResourceIntegrity.js";
import type { CloudInstallHealthReport } from "../../core/types/cloudAppDependencies.js";
import { readCloudAppDependenciesFile } from "./cloudAppResourceIntegrity.js";
import type { CloudAppDependenciesFile } from "../../core/types/cloudAppDependencies.js";

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const TEXT_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".py",
  ".md",
  ".css",
]);

async function runGit(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

async function gitPathExistsInHead(
  repoDir: string,
  relativePath: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const normalized = relativePath.replace(/\\/g, "/");
  try {
    await runGit(["rev-parse", "--verify", `HEAD:${normalized}`], {
      cwd: repoDir,
      env,
      timeoutMs: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function scanAppDirForJobIdCandidates(appDir: string): Promise<string[]> {
  const found = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name.startsWith(".")
        ) {
          continue;
        }
        await walk(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) {
        continue;
      }
      let raw: string;
      try {
        raw = await fs.readFile(full, "utf8");
      } catch {
        continue;
      }
      for (const match of raw.matchAll(UUID_PATTERN)) {
        found.add(match[0].toLowerCase());
      }
    }
  }

  await walk(appDir);
  return [...found];
}

async function seedJobIdsFromAppDir(appDir: string): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const raw = await fs.readFile(path.join(appDir, "data-sources.json"), "utf8");
    const config = parseDataSourcesFile(raw);
    for (const source of config.sources) {
      if (source.jobId) {
        ids.add(source.jobId);
      }
    }
  } catch {
    /* no data-sources */
  }
  return [...ids];
}

function toSparseCheckoutDirs(relativePaths: string[]): string[] {
  const dirPaths = new Set<string>();
  for (const rel of relativePaths.map((p) => p.replace(/\\/g, "/"))) {
    if (!rel) continue;
    if (rel.endsWith(".json")) {
      dirPaths.add(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".");
    } else {
      dirPaths.add(rel);
    }
  }
  return [...dirPaths].filter((p) => p !== ".");
}

/** Add sparse-checkout paths individually; skip paths missing from HEAD. */
async function expandSparseCheckoutResilient(
  repoDir: string,
  relativePaths: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ added: string[]; skipped: string[] }> {
  const unique = toSparseCheckoutDirs(relativePaths);
  const added: string[] = [];
  const skipped: string[] = [];

  for (const rel of unique) {
    if (rel !== "data") {
      const exists = await gitPathExistsInHead(repoDir, rel, env);
      if (!exists) {
        skipped.push(rel);
        console.warn(
          `[CloudAppInstall] Skipping sparse-checkout for missing repo path: ${rel}`,
        );
        continue;
      }
    }

    try {
      await runGit(["sparse-checkout", "add", rel], {
        cwd: repoDir,
        env,
        timeoutMs: 180_000,
      });
      added.push(rel);
    } catch (error) {
      skipped.push(rel);
      console.warn(
        `[CloudAppInstall] sparse-checkout add failed for ${rel}:`,
        (error as Error).message.slice(0, 160),
      );
    }
  }

  return { added, skipped };
}

/**
 * Sparse-checkout linked Jobs/ + data/ from the owner's repo before copying locally.
 */
export async function ensureRepoHasLinkedAppResources(input: {
  repoDir: string;
  repoAppDir: string;
  publisherAppId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ jobIds: string[]; skippedSparsePaths: string[] }> {
  const env = input.env ?? ephemeralGitEnv();

  const seedIds = new Set<string>(await seedJobIdsFromAppDir(input.repoAppDir));
  for (const id of await scanAppDirForJobIdCandidates(input.repoAppDir)) {
    seedIds.add(id);
  }

  const initialPaths = [
    "data",
    ...[...seedIds].map((jobId) => jobRelativePath(jobId)),
  ];
  const initialCheckout = await expandSparseCheckoutResilient(
    input.repoDir,
    initialPaths,
    env,
  );

  const resolved = resolveAppDependentJobIds(input.repoDir, input.publisherAppId, {
    sourceAppId: input.publisherAppId,
  });

  const missingJobPaths = resolved
    .map((jobId) => jobRelativePath(jobId))
    .filter((rel) => !initialPaths.includes(rel));
  let skipped = [...initialCheckout.skipped];
  if (missingJobPaths.length > 0) {
    const followUp = await expandSparseCheckoutResilient(
      input.repoDir,
      missingJobPaths,
      env,
    );
    skipped = [...skipped, ...followUp.skipped];
  }

  return { jobIds: resolved, skippedSparsePaths: skipped };
}

export interface InstallCloudAppLinkedResourcesResult {
  jobIds: string[];
  copiedJobIds: string[];
  skippedJobIds: string[];
  promotedJobIds: string[];
  skippedSparsePaths: string[];
  dependencies: CloudAppDependenciesFile | null;
  health: CloudInstallHealthReport;
}

export async function installCloudAppLinkedResources(input: {
  repoDir: string;
  repoAppDir: string;
  publisherAppId: string;
  localAppId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallCloudAppLinkedResourcesResult> {
  const checkout = await ensureRepoHasLinkedAppResources(input);

  const sync = await syncAppLinkedResourcesToTarget({
    appId: input.localAppId,
    sourceAppId: input.publisherAppId,
    sourcePaprHome: input.repoDir,
    targetPaprHome: getPaprRoot(),
  });

  if (sync.registryDbIds.length > 0 || sync.copiedJobIds.length > 0) {
    const { preparePortableReplicaDatabases } = await import(
      "./tursoReplica/portableReplicaBootstrap.js"
    );
    await preparePortableReplicaDatabases({
      paprHome: getPaprRoot(),
      registryDbIds: sync.registryDbIds,
      copiedJobIds: sync.copiedJobIds,
      reason: "portable_install",
    });
  }

  const localAppDir = path.join(getPaprAppsRoot(), input.localAppId);
  let promotedJobIds: string[] = [];
  const needsFallback = checkout.jobIds.some(
    (jobId) => !existsSync(path.join(getPaprRoot(), "Jobs", jobId, "job.json")),
  );

  if (needsFallback && existsSync(localAppDir)) {
    const promoted = await promoteBundledAppJobsToRegistry({
      localAppId: input.localAppId,
      localAppDir,
      paprHome: getPaprRoot(),
    });
    promotedJobIds = promoted.promotedJobIds;
    if (promotedJobIds.length > 0) {
      await finalizePortableCloudAppResources();
    }
  }

  const dependencies = await readCloudAppDependenciesFile(localAppDir);
  const health = await assessCloudInstallHealth({
    paprHome: getPaprRoot(),
    appId: input.localAppId,
    expectedJobIds: checkout.jobIds,
    promotedJobIds,
  });

  return {
    jobIds: checkout.jobIds,
    copiedJobIds: [...new Set([...sync.copiedJobIds, ...promotedJobIds])],
    skippedJobIds: sync.skippedJobIds,
    promotedJobIds,
    skippedSparsePaths: checkout.skippedSparsePaths,
    dependencies,
    health,
  };
}

/** Repair data-sources, registry, and job command paths after cloud install/sync. */
export async function finalizePortableCloudAppResources(): Promise<void> {
  const { repairWorkspacePortableDataSources } = await import(
    "./portableDataSources.js"
  );
  await repairWorkspacePortableDataSources();

  const { runPostMigrationPathRepair } = await import(
    "./postMigrationPathRepair.js"
  );
  await runPostMigrationPathRepair({
    dryRun: false,
    includeApps: false,
    delayMs: 0,
    paprBase: getPaprRoot(),
    scopePaprHome: getPaprRoot(),
    skipDataSources: false,
  });

  try {
    const { getJobsService } = await import("./JobsService.js");
    await getJobsService().initialize();
  } catch {
    /* gateway may not have jobs service yet during tests */
  }
}
