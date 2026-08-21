/**
 * Bundled Home dashboard + Daily Brief job — shared constants and install helpers.
 * Each workspace gets its own Daily Brief job UUID (Turso short name j-{id8}).
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { promises as fs } from "fs";
import path from "path";
import type { AppDataSource } from "./appDataSources.js";
import {
  canonicalJobDatabasePath,
  isPathWithinWorkspace,
} from "./appDataSources.js";
import type { JobRecord } from "./jobs/types.js";

export const DEFAULT_HOME_APP_ID = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";
export const DEFAULT_HOME_DAILY_BRIEF_BUNDLED_SLUG = "daily-brief-generator";
export const DEFAULT_HOME_DAILY_BRIEF_JOB_NAME = "Daily Brief Generator";
export const DEFAULT_HOME_JOB_ID_FILE = "default-job-id.txt";

/** Legacy fixed UUID from early bundles — migration lookup only. */
export const LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID =
  "2cafb2e9-696b-42db-98fa-5d605977123c";

/** @deprecated Use resolveHomeDailyBriefJobId — kept for existing tests/migrations. */
export const DEFAULT_HOME_DAILY_BRIEF_JOB_ID = LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID;

export interface BundledDefaultJobDef {
  bundledSlug?: string;
  id?: string;
  name: string;
  type: JobRecord["type"];
  command?: string;
  schedule?: JobRecord["schedule"];
  retries?: JobRecord["retries"];
  outputMode?: JobRecord["outputMode"];
  memoryPolicy?: JobRecord["memoryPolicy"];
  provider?: string;
  model?: string;
}

export function buildDailyBriefDataSource(
  jobId: string,
  dbPath: string,
): AppDataSource {
  const short = jobId.slice(0, 8);
  return {
    id: `${jobId}:Daily Brief Generator (${short})`,
    type: "sqlite",
    jobId,
    alias: `Daily Brief Generator (${short})`,
    dbPath,
    tables: ["briefs"],
    linkedAt: new Date().toISOString(),
  };
}

function isHomeDailyBriefRegistryJob(job: JobRecord): boolean {
  if (job.id.endsWith(".migrated")) {
    return false;
  }
  if (
    job.name === DEFAULT_HOME_DAILY_BRIEF_JOB_NAME &&
    job.appIds?.includes(DEFAULT_HOME_APP_ID)
  ) {
    return true;
  }
  return job.id === LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID;
}

export function findHomeDailyBriefJobIdInRegistry(
  jobs: Iterable<JobRecord>,
  options?: { preferJobId?: string },
): string | undefined {
  const prefer = options?.preferJobId?.trim();
  if (prefer) {
    for (const job of jobs) {
      if (job.id === prefer && isHomeDailyBriefRegistryJob(job)) {
        return prefer;
      }
    }
  }

  const linked: JobRecord[] = [];
  for (const job of jobs) {
    if (isHomeDailyBriefRegistryJob(job)) {
      linked.push(job);
    }
  }

  if (linked.length === 0) {
    return undefined;
  }

  const nonLegacy = linked.filter(
    (job) => job.id !== LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID,
  );
  if (nonLegacy.length === 1) {
    return nonLegacy[0].id;
  }
  if (nonLegacy.length > 1) {
    if (prefer) {
      const match = nonLegacy.find((job) => job.id === prefer);
      if (match) {
        return match.id;
      }
    }
    return nonLegacy[0].id;
  }

  return linked[0]?.id;
}

export async function readHomeDailyBriefJobIdFromAppDir(
  appDir: string,
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(
      path.join(appDir, DEFAULT_HOME_JOB_ID_FILE),
      "utf8",
    );
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeHomeDailyBriefJobIdToAppDir(
  appDir: string,
  jobId: string,
): Promise<void> {
  await fs.writeFile(
    path.join(appDir, DEFAULT_HOME_JOB_ID_FILE),
    `${jobId.trim()}\n`,
    "utf8",
  );
}

export function resolveHomeDailyBriefJobId(params: {
  appDir: string;
  jobIdFromFile?: string;
  jobExists: (jobId: string) => boolean;
  findLinkedJobId?: () => string | undefined;
}): string | undefined {
  const fromFile = params.jobIdFromFile?.trim();
  if (fromFile && params.jobExists(fromFile)) {
    return fromFile;
  }

  if (params.jobExists(LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID)) {
    return LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID;
  }

  const linked = params.findLinkedJobId?.();
  if (linked && params.jobExists(linked)) {
    return linked;
  }

  return undefined;
}

export async function resolveOrAllocateHomeDailyBriefJobId(params: {
  appDir: string;
  jobExists: (jobId: string) => boolean;
  findLinkedJobId?: () => string | undefined;
}): Promise<string> {
  const fromFile = await readHomeDailyBriefJobIdFromAppDir(params.appDir);
  const existing = resolveHomeDailyBriefJobId({
    appDir: params.appDir,
    jobIdFromFile: fromFile,
    jobExists: params.jobExists,
    findLinkedJobId: params.findLinkedJobId,
  });
  if (existing) {
    await writeHomeDailyBriefJobIdToAppDir(params.appDir, existing);
    return existing;
  }

  const jobId = randomUUID();
  await writeHomeDailyBriefJobIdToAppDir(params.appDir, jobId);
  return jobId;
}

export function shouldRewriteDailyBriefDbPath(params: {
  storedDbPath: string | undefined;
  resolvedDbPath: string;
  workspaceRoot: string;
}): boolean {
  const stored = params.storedDbPath?.trim() ?? "";
  if (stored.length === 0) {
    return existsSync(params.resolvedDbPath);
  }

  const normalizedStored = path.normalize(stored);
  const normalizedResolved = path.normalize(params.resolvedDbPath);
  if (normalizedStored === normalizedResolved) {
    return false;
  }

  if (!isPathWithinWorkspace(stored, params.workspaceRoot)) {
    return existsSync(params.resolvedDbPath);
  }

  return false;
}

export function resolveDailyBriefDbPath(
  jobsRoot: string,
  jobId: string,
): string {
  return canonicalJobDatabasePath(jobsRoot, jobId);
}
