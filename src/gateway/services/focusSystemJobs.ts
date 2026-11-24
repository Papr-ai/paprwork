/**
 * Focus system jobs: the Daily Brief and the per-goal trackers.
 *
 * Papr Work owns them, not the Home mini-app. They are standalone jobs in the "focus" /
 * "focus-trackers" folders and write the Focus DB through /api/focus/* (focusRoutes.ts),
 * so they keep working with no Home app installed.
 *
 * Existing workspaces: the Home-linked Daily Brief job keeps its id, history and schedule;
 * this only re-links it (appIds, folder, command, save_brief.py). Same for trackers.
 */
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import type { JobRecord } from "./jobs/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FOCUS_JOBS_FOLDER = "focus";
export const FOCUS_TRACKERS_FOLDER = "focus-trackers";
export const DAILY_BRIEF_JOB_NAME = "Daily Brief Generator";
const STANDALONE = ["__standalone__"];
const LEGACY_HOME_APP_ID = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";

interface BundledBriefJob {
  name: string;
  type: JobRecord["type"];
  command: string;
  schedule?: JobRecord["schedule"];
  retries?: JobRecord["retries"];
  outputMode?: JobRecord["outputMode"];
  memoryPolicy?: JobRecord["memoryPolicy"];
  recipe?: JobRecord["recipe"];
  executionCapability?: JobRecord["executionCapability"];
}

export async function dailyBriefBundleDir(): Promise<string | null> {
  const { resolveBundledResourcesDir } = await import("../../core/utils/bundledResourcesPath.js");
  return resolveBundledResourcesDir(__dirname, "resources/focus/daily-brief");
}

/** The Daily Brief job: native one first, then the one Home used to own. */
export function findDailyBriefJob(jobs: Iterable<JobRecord>, homeJobId?: string): JobRecord | undefined {
  const list = [...jobs].filter((j) => !j.id.endsWith(".migrated"));
  return (
    list.find((j) => j.name === DAILY_BRIEF_JOB_NAME && j.folder === FOCUS_JOBS_FOLDER) ??
    (homeJobId ? list.find((j) => j.id === homeJobId) : undefined) ??
    list.find((j) => j.name === DAILY_BRIEF_JOB_NAME && j.appIds?.includes(LEGACY_HOME_APP_ID))
  );
}

/** Fields a Focus job must have; returns only what differs from the job. */
export function focusJobPatch(job: Pick<JobRecord, "appIds" | "folder" | "writeDbIds">, folder: string): Partial<JobRecord> {
  const patch: Partial<JobRecord> = {};
  if (JSON.stringify(job.appIds ?? []) !== JSON.stringify(STANDALONE)) patch.appIds = STANDALONE;
  if (job.folder !== folder) patch.folder = folder;
  if (job.writeDbIds?.length) patch.writeDbIds = [];
  return patch;
}

async function homeJobIdFromFile(): Promise<string | undefined> {
  const { getPaprAppsRoot } = await import("../../core/utils/paprRoot.js");
  try {
    return (await fs.readFile(path.join(getPaprAppsRoot(), LEGACY_HOME_APP_ID, "default-job-id.txt"), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

let running: Promise<string | null> | null = null;

/** Create or re-link the Daily Brief job. Returns its id, or null when the bundle is missing. */
export function ensureDailyBriefJob(): Promise<string | null> {
  running ??= ensureDailyBriefJobOnce().finally(() => {
    running = null;
  });
  return running;
}

async function ensureDailyBriefJobOnce(): Promise<string | null> {
  const bundle = await dailyBriefBundleDir();
  if (!bundle) return null;
  const def = JSON.parse(await fs.readFile(path.join(bundle, "job.json"), "utf8")) as BundledBriefJob;
  const { getJobsService } = await import("./JobsService.js");
  const svc = getJobsService();
  await svc.initialize();
  const { normalizePortableJobPrompt } = await import("./jobs/normalizePortableJobPrompt.js");
  const command = normalizePortableJobPrompt(def.command);

  let job = findDailyBriefJob(await svc.listJobs(), await homeJobIdFromFile());
  if (!job) {
    const id = randomUUID();
    await svc.installDefaultJob({
      id,
      name: def.name,
      type: def.type,
      command,
      schedule: def.schedule,
      retries: def.retries,
      outputMode: def.outputMode,
      memoryPolicy: def.memoryPolicy,
      appIds: STANDALONE,
      folder: FOCUS_JOBS_FOLDER,
      executionCapability: def.executionCapability,
    });
    job = (await svc.getJob(id)) ?? undefined;
    if (!job) return null;
    console.log(`[FocusJobs] Created Daily Brief job ${id}`);
  }

  const patch: Partial<JobRecord> = focusJobPatch(job, FOCUS_JOBS_FOLDER);
  if (job.command !== command) patch.command = command;
  if (def.recipe && JSON.stringify(def.recipe) !== JSON.stringify(job.recipe ?? null)) patch.recipe = def.recipe;
  if (!job.retries && def.retries) patch.retries = def.retries;
  if (job.executionCapability !== def.executionCapability) patch.executionCapability = def.executionCapability;
  if (Object.keys(patch).length && job.status !== "running") {
    await svc.updateJob(job.id, patch as Parameters<typeof svc.updateJob>[1]);
    console.log(`[FocusJobs] Daily Brief job ${job.id} updated: ${Object.keys(patch).join(", ")}`);
  }

  const jobDir = await svc.getJobPath(job.id);
  if (jobDir) await fs.copyFile(path.join(bundle, "save_brief.py"), path.join(jobDir, "save_brief.py"));
  try {
    const { getRecipeService } = await import("./jobs/RecipeService.js");
    await getRecipeService().writeRecipe(job.id, await fs.readFile(path.join(bundle, "recipe.md"), "utf8"));
  } catch {
    /* recipe is optional */
  }
  return job.id;
}

/** Trackers created while Home owned Focus: move them to standalone. */
export async function relinkFocusTrackers(): Promise<number> {
  const { getJobsService } = await import("./JobsService.js");
  const svc = getJobsService();
  await svc.initialize();
  let moved = 0;
  for (const job of await svc.listJobs()) {
    if (job.folder !== FOCUS_TRACKERS_FOLDER || job.status === "running") continue;
    const patch = focusJobPatch(job, FOCUS_TRACKERS_FOLDER);
    if (!patch.appIds) continue;
    await svc.updateJob(job.id, patch as Parameters<typeof svc.updateJob>[1]);
    moved += 1;
  }
  if (moved) console.log(`[FocusJobs] Re-linked ${moved} Focus tracker job(s) as standalone`);
  return moved;
}

export async function ensureFocusSystemJobs(): Promise<void> {
  const { isCloudAgentGatewayMode } = await import("../../core/utils/paprRoot.js");
  // Cloud sandbox: jobs come from the cloud repos; rewriting them there would publish over the real ones.
  if (isCloudAgentGatewayMode()) return;
  try {
    await ensureDailyBriefJob();
    await relinkFocusTrackers();
  } catch (err) {
    console.warn("[FocusJobs] Could not set up Focus jobs:", err instanceof Error ? err.message : err);
  }
}
