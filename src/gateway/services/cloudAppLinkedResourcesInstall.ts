/**
 * Install / update jobs and registry entries when cloud-installing or
 * track-syncing a mini-app from the owner's git repo.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import { parseDataSourcesFile } from "./appDataSources.js";
import {
  jobRelativePath,
  resolveAppDependentJobIds,
} from "./cloudSync/resolveAppDependentJobs.js";
import { syncAppLinkedResourcesToTarget } from "./copyAppToNamespace.js";

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

async function expandSparseCheckout(
  repoDir: string,
  relativePaths: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // Cone-mode sparse checkout only accepts directories — map files to parent dirs.
  const dirPaths = new Set<string>();
  for (const rel of relativePaths.map((p) => p.replace(/\\/g, "/"))) {
    if (!rel) continue;
    if (rel.endsWith(".json")) {
      dirPaths.add(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".");
    } else {
      dirPaths.add(rel);
    }
  }
  const unique = [...dirPaths].filter((p) => p !== ".");
  if (unique.length === 0) {
    return;
  }
  await runGit(["sparse-checkout", "add", ...unique], {
    cwd: repoDir,
    env,
    timeoutMs: 180_000,
  });
}

/**
 * Sparse-checkout linked Jobs/ + data/ from the owner's repo before copying locally.
 */
export async function ensureRepoHasLinkedAppResources(input: {
  repoDir: string;
  repoAppDir: string;
  publisherAppId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const env = input.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  const seedIds = new Set<string>(await seedJobIdsFromAppDir(input.repoAppDir));
  for (const id of await scanAppDirForJobIdCandidates(input.repoAppDir)) {
    seedIds.add(id);
  }

  const initialPaths = [
    "data",
    ...[...seedIds].map((jobId) => jobRelativePath(jobId)),
  ];
  await expandSparseCheckout(input.repoDir, initialPaths, env);

  const resolved = resolveAppDependentJobIds(input.repoDir, input.publisherAppId, {
    sourceAppId: input.publisherAppId,
  });

  const missingJobPaths = resolved
    .map((jobId) => jobRelativePath(jobId))
    .filter((rel) => !initialPaths.includes(rel));
  if (missingJobPaths.length > 0) {
    await expandSparseCheckout(input.repoDir, missingJobPaths, env);
  }

  return resolved;
}

export interface InstallCloudAppLinkedResourcesResult {
  jobIds: string[];
  copiedJobIds: string[];
  skippedJobIds: string[];
}

export async function installCloudAppLinkedResources(input: {
  repoDir: string;
  repoAppDir: string;
  publisherAppId: string;
  localAppId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallCloudAppLinkedResourcesResult> {
  const jobIds = await ensureRepoHasLinkedAppResources(input);

  const sync = await syncAppLinkedResourcesToTarget({
    appId: input.localAppId,
    sourceAppId: input.publisherAppId,
    sourcePaprHome: input.repoDir,
    targetPaprHome: getPaprRoot(),
  });

  return {
    jobIds,
    copiedJobIds: sync.copiedJobIds,
    skippedJobIds: sync.skippedJobIds,
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
    scopePaprHome: getPaprRoot(),
    skipDataSources: true,
  });

  try {
    const { getJobsService } = await import("./JobsService.js");
    await getJobsService().initialize();
  } catch {
    /* gateway may not have jobs service yet during tests */
  }
}
