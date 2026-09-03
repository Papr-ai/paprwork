import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { ChildProcess } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { writeJsonAtomic, parseJsonTolerant } from "../../core/utils/atomicJsonWrite.js";
import { JobDatabase } from "./jobs/JobDatabase.js";
import {
  formatJobArchitectureErrors,
  type JobArchitectureIssue,
  validateJobArchitecture,
} from "./jobs/jobArchitectureValidation.js";
import { CommandJobExecutor } from "./jobs/executors/CommandJobExecutor.js";
import { formatSpawnErrorForLogs } from "../../core/utils/childProcessErrors.js";
import { AgentJobExecutor } from "./jobs/executors/AgentJobExecutor.js";
import type { IJobExecutor } from "./jobs/executors/IJobExecutor.js";
import { sanitizeError } from "../../core/tools/security.js";
import { getGatewayTelemetry } from "./gatewayTelemetry.js";
import {
  buildJobRunDimensions,
  isAgentJobType,
} from "../../core/telemetry/jobRunTelemetry.js";
import type { JobRunTrigger } from "../../core/telemetry/jobRunTelemetry.js";
import { getJobRunHistory } from "./jobs/JobRunHistory.js";
import {
  getPaprAppsRoot,
  getPaprDataDir,
  getPaprJobsRoot,
  getPaprRoot,
} from "../../core/utils/paprRoot.js";
import {
  jobUpdateAffectsOwnership,
  notifyJobOwnershipChanged,
} from "./cloudSync/jobOwnershipInvalidation.js";
import {
  resolveJobWriteTargets,
  validateWriteDbIdsExist,
} from "./jobAppDatabase.js";
import {
  type AppDataContract,
  validateJobAgainstAppDatabase,
} from "./jobs/jobDatabaseArchitectureValidation.js";
import { resolveBundledResourcesDir } from "../../core/utils/bundledResourcesPath.js";
import {
  canPerformWorkspaceWrite,
  getWorkspaceWriteGeneration,
} from "./workspaceWriteGuard.js";
import { isWorkspaceChatJob } from "../../core/constants/workspaceChatJob.js";

// ESM compatibility: get __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  classifyError,
  getErrorClassificationReason,
} from "./jobs/errorClassifier.js";
import { getJobEventHub } from "./JobEventHub.js";
import {
  parseJobProgressLine,
  toJobProgressData,
} from "../utils/parseJobProgressLine.js";

/** Short, single-line hint for telemetry (no raw logs; keys avoid "message" substring). */
function truncateForTelemetryHint(raw: string | undefined, maxLen: number): string {
  if (!raw) {
    return "";
  }
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
}
import type {
  ActiveJobSummary,
  CreateJobInput,
  JobGraph,
  JobGraphAppLink,
  JobGraphEdge,
  JobRecord,
  JobSchedule,
  JobStatus,
  JobType,
} from "./jobs/types.js";
import {
  assertCreateAppIds,
  jobBelongsToApp,
  mergeJobAppIds,
  STANDALONE_APP_ID,
} from "./jobs/appIds.js";
import {
  computeInitialNextRunAt,
  computeMisfireSkipNextRunAt,
} from "./jobs/scheduleEngine.js";
import {
  JOB_RUNTIME_FILE_NAME,
  jobRecordToRuntimePatch,
  mergeJobConfigAndRuntime,
  parseJobStatus,
  parseMonolithicJobJson,
  recordHasRuntimeFields,
  splitJobRecord,
  toConfigIndexEntry,
} from "./jobs/jobRuntimeFields.js";
import type { JobRuntimePatch } from "../types/cloudRuntime.js";
export type {
  ActiveJobSummary,
  CreateJobInput,
  JobDelivery,
  JobDependency,
  JobExecutionCapability,
  JobGraph,
  JobGraphAppLink,
  JobGraphEdge,
  JobMemoryPolicy,
  JobRecord,
  JobRetryPolicy,
  JobSchedule,
  JobScheduleState,
  JobStatus,
  JobType,
  RecipeConfig,
  RecipeEvaluation,
  RecipeEvaluationSummary,
  RecipeEvalCriterion,
} from "./jobs/types.js";
export { STANDALONE_APP_ID } from "./jobs/appIds.js";

let jobsServiceInstance: JobsService | null = null;

function logJobsStartupStep(phase: "Init" | "Maintenance", label: string): void {
  if (process.env.PAPR_DEBUG_STARTUP === "1") {
    console.log(`[JobsService] ${phase}: ${label}…`);
  }
}

export class JobsService {
  private legacyJobsRootDir: string;
  private legacyJobsIndexPath: string;
  private jobs: Map<string, JobRecord>;
  private running: Map<string, ChildProcess>;
  private jobDatabase: JobDatabase;
  private executors: IJobExecutor[];
  private initialized: boolean;
  private initPromise: Promise<void> | null = null;
  /** Background migrations/hydration — await before home repair or scheduler start. */
  private startupMaintenancePromise: Promise<void> | null = null;
  private saveLock: Promise<void> | null = null; // Prevent concurrent saves
  /** Set when startup reconcile deletes jobs; triggers one batched cloud push after init. */
  private deferredDeleteCloudPush = false;
  /** Workspace bound at initialize — disk writes never follow getPaprRoot() mid-flight. */
  private boundPaprDir: string | null = null;
  private boundWriteGeneration: number | null = null;

  constructor() {
    const homeDir = os.homedir();
    this.legacyJobsRootDir = path.join(homeDir, "papr-jobs");
    this.legacyJobsIndexPath = path.join(
      homeDir,
      ".paprwork",
      "data",
      "jobs.json",
    );
    this.jobs = new Map();
    this.running = new Map();
    this.jobDatabase = new JobDatabase();
    this.executors = [
      new CommandJobExecutor(["shell", "bash", "node", "python", "swift"]),
      new AgentJobExecutor(),
    ];
    this.initialized = false;
  }

  private get jobsRootDir(): string {
    return this.boundPaprDir
      ? path.join(this.boundPaprDir, "Jobs")
      : getPaprJobsRoot();
  }

  private get jobsIndexPath(): string {
    return this.boundPaprDir
      ? path.join(this.boundPaprDir, "data", "jobs.json")
      : path.join(getPaprDataDir(), "jobs.json");
  }

  private get graphPath(): string {
    return this.boundPaprDir
      ? path.join(this.boundPaprDir, "data", "job-graph.json")
      : path.join(getPaprDataDir(), "job-graph.json");
  }

  private bindWorkspaceWriteContext(): void {
    this.boundPaprDir = getPaprRoot();
    this.boundWriteGeneration = getWorkspaceWriteGeneration();
  }

  private isWriteContextValid(context: string): boolean {
    if (this.boundPaprDir === null || this.boundWriteGeneration === null) {
      return true;
    }
    return canPerformWorkspaceWrite(
      this.boundWriteGeneration,
      this.boundPaprDir,
      context,
    );
  }

  /** Reload index from disk after PAPR_HOME changes (cloud agent gateway). */
  async resetForWorkspaceReload(): Promise<void> {
    this.initialized = false;
    this.startupMaintenancePromise = null;
    this.jobs.clear();
    this.boundPaprDir = null;
    this.boundWriteGeneration = null;
  }

  private async migrateLegacyIfNeeded(): Promise<void> {
    let hasNewIndex = true;
    try {
      await fs.access(this.jobsIndexPath);
    } catch {
      hasNewIndex = false;
    }

    let hasLegacyIndex = true;
    try {
      await fs.access(this.legacyJobsIndexPath);
    } catch {
      hasLegacyIndex = false;
    }

    if (!hasNewIndex && hasLegacyIndex) {
      await fs.mkdir(path.dirname(this.jobsIndexPath), { recursive: true });
      await fs.copyFile(this.legacyJobsIndexPath, this.jobsIndexPath);
    }

    let hasNewJobsDir = true;
    try {
      await fs.access(this.jobsRootDir);
    } catch {
      hasNewJobsDir = false;
    }

    let hasLegacyJobsDir = true;
    try {
      await fs.access(this.legacyJobsRootDir);
    } catch {
      hasLegacyJobsDir = false;
    }

    if (!hasNewJobsDir && hasLegacyJobsDir) {
      await fs.mkdir(path.dirname(this.jobsRootDir), { recursive: true });
      await fs.cp(this.legacyJobsRootDir, this.jobsRootDir, {
        recursive: true,
      });
    }
  }

  /**
   * Install default jobs from src/resources/default-jobs/ if they don't exist yet.
   * Called on first launch to provide pre-built jobs like the Daily Brief generator.
   */
  private async installDefaultJobs(): Promise<void> {
    try {
      const defaultJobsDir = await resolveBundledResourcesDir(
        __dirname,
        "resources/default-jobs",
      );
      if (!defaultJobsDir) {
        console.log("[JobsService] No default jobs directory found, skipping installation");
        return;
      }

      // Get list of default jobs
      const defaultJobDirs = await fs.readdir(defaultJobsDir);
      let installedCount = 0;
      
      for (const jobDirName of defaultJobDirs) {
        const sourceDir = path.join(defaultJobsDir, jobDirName);
        const stat = await fs.stat(sourceDir);
        
        if (!stat.isDirectory()) continue;

        // Read job.json to get job configuration
        const jobJsonPath = path.join(sourceDir, "job.json");
        let jobConfig: JobRecord;
        try {
          const jobJsonContent = await fs.readFile(jobJsonPath, "utf-8");
          jobConfig = JSON.parse(jobJsonContent);
        } catch {
          console.warn(`[JobsService] Skipping default job ${jobDirName}: no job.json`);
          continue;
        }

        const jobId = jobConfig.id;
        if (!jobId) {
          console.warn(`[JobsService] Skipping default job ${jobDirName}: no id in job.json`);
          continue;
        }

        const { LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID } = await import(
          "./defaultHomeBundle.js"
        );
        const { readMigrationMarker } = await import(
          "./migrateLegacyHomeDailyBriefJob.js"
        );
        const homeMigrationMarker = await readMigrationMarker(getPaprRoot());
        if (
          jobId === LEGACY_DEFAULT_HOME_DAILY_BRIEF_JOB_ID &&
          homeMigrationMarker?.toJobId &&
          homeMigrationMarker.toJobId !== jobId
        ) {
          console.log(
            `[JobsService] Skipping bundled legacy Daily Brief (${jobId}) — workspace uses ${homeMigrationMarker.toJobId}`,
          );
          continue;
        }

        const { readJobTombstones } = await import("./jobs/jobTombstones.js");
        const tombstones = await readJobTombstones(getPaprRoot());
        if (tombstones.has(jobId)) {
          console.log(
            `[JobsService] Skipping tombstoned default job: ${jobId} (${jobConfig.name})`,
          );
          continue;
        }

        // Check if job already exists (both in registry and on disk)
        if (this.jobs.has(jobId)) {
          console.log(`[JobsService] Default job already in registry: ${jobId} (${jobConfig.name})`);
          continue;
        }

        const targetDir = path.join(this.jobsRootDir, jobId);
        let needsInstall = false;
        try {
          await fs.access(targetDir);
          console.log(`[JobsService] Default job files exist but not in registry: ${jobId}`);
          // Files exist but not registered - add to registry below
        } catch {
          // Job doesn't exist, install files
          needsInstall = true;
        }

        if (needsInstall) {
          // Copy entire job folder including data/ with empty database
          await fs.cp(sourceDir, targetDir, { recursive: true });
          console.log(`[JobsService] Copied default job files: ${jobId} (${jobConfig.name})`);
        }

        // Register job in memory (reset status to idle, clear runtime fields)
        const now = new Date().toISOString();
        const job: JobRecord = {
          ...jobConfig,
          status: "idle" as JobStatus,
          updatedAt: now,
          // Clear runtime fields from bundled job.json
          lastRunAt: undefined,
          error: undefined,
          exitCode: undefined,
          lastOutput: undefined,
          currentExecutionId: undefined,
          currentAttempt: undefined,
          completedAt: undefined,
        };

        this.jobs.set(jobId, job);
        installedCount++;
        console.log(`[JobsService] Registered default job: ${jobId} - ${job.name}`);
      }

      // Save jobs index if any jobs were installed
      if (installedCount > 0) {
        await this.saveJobs();
        console.log(`[JobsService] Installed and registered ${installedCount} default job(s)`);
      }
    } catch (error) {
      console.error("[JobsService] Failed to install default jobs:", error);
      // Don't throw - default jobs are nice-to-have, not critical
    }
  }

  /** Hidden agent job for Papr Web workspace chat (main Pen parity). */
  private async installWorkspaceChatJob(): Promise<void> {
    try {
      const { buildWorkspaceChatJobRecord } = await import(
        "../../core/constants/workspaceChatJob.js"
      );
      await this.installDefaultJob({
        ...buildWorkspaceChatJobRecord(),
        hidden: true,
        workspaceChatJob: true,
      } as Partial<import("./jobs/types.js").JobRecord> & {
        id: string;
        name: string;
        type: import("./jobs/types.js").JobType;
      });
    } catch (error) {
      console.warn("[JobsService] Failed to install workspace-chat job:", error);
    }
  }

  /**
   * Sync Home Daily Brief agent prompt from bundled default-job.json.
   * Each workspace owns its own job UUID — match by Home app link + job name.
   */
  private async syncHomeDailyBriefFromBundle(): Promise<void> {
    const bundledAppsDir = await resolveBundledResourcesDir(
      __dirname,
      "resources/default-apps/home-dashboard",
    );
    if (!bundledAppsDir) {
      return;
    }

    const jobDefPath = path.join(bundledAppsDir, "default-job.json");
    let bundledDef: {
      command?: string;
      appIds?: string[];
      name?: string;
      recipe?: JobRecord["recipe"];
    };
    try {
      bundledDef = JSON.parse(
        await fs.readFile(jobDefPath, "utf8"),
      ) as typeof bundledDef;
    } catch {
      return;
    }

    const { findHomeDailyBriefJobIdInRegistry, DEFAULT_HOME_APP_ID, readHomeDailyBriefJobIdFromAppDir } =
      await import("./defaultHomeBundle.js");
    const { normalizePortableJobPrompt } = await import(
      "./jobs/normalizePortableJobPrompt.js"
    );

    const homeAppDir = path.join(getPaprAppsRoot(), DEFAULT_HOME_APP_ID);
    const preferJobId = await readHomeDailyBriefJobIdFromAppDir(homeAppDir);
    const jobId = findHomeDailyBriefJobIdInRegistry(this.jobs.values(), {
      preferJobId,
    });
    if (!jobId) {
      return;
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    const nextCommand = bundledDef.command?.trim();
    if (!nextCommand) {
      return;
    }

    const normalizedCommand = normalizePortableJobPrompt(nextCommand);
    const nextAppIds = bundledDef.appIds?.length
      ? bundledDef.appIds
      : [DEFAULT_HOME_APP_ID];
    const commandChanged = normalizedCommand !== (job.command ?? "");
    const appIdsChanged =
      JSON.stringify(nextAppIds) !== JSON.stringify(job.appIds ?? []);
    const bundledRecipe = bundledDef.recipe;
    const recipeChanged =
      bundledRecipe !== undefined &&
      JSON.stringify(bundledRecipe) !== JSON.stringify(job.recipe ?? null);

    if (!commandChanged && !appIdsChanged && !recipeChanged) {
      return;
    }

    const updated: JobRecord = {
      ...job,
      ...(commandChanged ? { command: normalizedCommand } : {}),
      ...(appIdsChanged ? { appIds: nextAppIds } : {}),
      ...(recipeChanged ? { recipe: bundledRecipe } : {}),
      updatedAt: new Date().toISOString(),
    };

    this.jobs.set(jobId, updated);
    try {
      await this.persistJobRecord(updated);
      await this.syncBundledHomeDailyBriefRecipe(bundledAppsDir, jobId);
      await this.saveJobs();
      console.log(
        `[JobsService] Synced Home Daily Brief job ${jobId} from bundled default-job.json`,
      );
    } catch (err) {
      console.warn(
        `[JobsService] Could not sync Home Daily Brief job ${jobId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Copy bundled recipe.md into the workspace Daily Brief job folder when present. */
  private async syncBundledHomeDailyBriefRecipe(
    bundledAppDir: string,
    jobId: string,
  ): Promise<void> {
    const recipePath = path.join(bundledAppDir, "recipe.md");
    try {
      const markdown = await fs.readFile(recipePath, "utf8");
      const { getRecipeService } = await import("./jobs/RecipeService.js");
      await getRecipeService().writeRecipe(jobId, markdown);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(
          `[JobsService] Could not sync bundled recipe for ${jobId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.runInitialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async runInitialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.runCoreInitialize();
    this.startupMaintenancePromise = this.runDeferredStartupMaintenance();
    void this.startupMaintenancePromise.catch((err) => {
      console.warn(
        "[JobsService] Deferred startup maintenance failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }

  /** Fast path — registry loaded and scheduler-safe before gateway routes register. */
  private async runCoreInitialize(): Promise<void> {
    const startedAt = performance.now();
    logJobsStartupStep("Init", "bind workspace");
    this.bindWorkspaceWriteContext();
    logJobsStartupStep("Init", "legacy migration");
    await this.migrateLegacyIfNeeded();
    logJobsStartupStep("Init", "ensure directories");
    await fs.mkdir(this.jobsRootDir, { recursive: true });
    await fs.mkdir(path.dirname(this.jobsIndexPath), { recursive: true });
    logJobsStartupStep("Init", "load jobs index");
    await this.loadJobs();
    logJobsStartupStep("Init", "filter tombstones");
    await this.filterTombstonedJobsFromRegistry();

    logJobsStartupStep("Init", "run history");
    const runHistory = getJobRunHistory();
    await runHistory.initialize();

    logJobsStartupStep("Init", "reconcile interrupted jobs");
    await this.reconcileInterruptedJobs();

    logJobsStartupStep("Init", "reconcile stale running jobs");
    await this.reconcileStaleRunningJobs(30_000);

    logJobsStartupStep("Init", "reconcile schedule states");
    await this.reconcileScheduleStates();

    this.initialized = true;
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.log(
      `[JobsService] Core init complete (${this.jobs.size} jobs, ${elapsedMs}ms; maintenance in background)`,
    );
  }

  /** Migrations, cloud hydration, and bundled job installs — safe to defer. */
  private async runDeferredStartupMaintenance(): Promise<void> {
    const startedAt = performance.now();
    try {
      logJobsStartupStep("Maintenance", "migrate Home Daily Brief");
      await this.migrateLegacyHomeDailyBriefJobIfNeeded();
      logJobsStartupStep("Maintenance", "migrate job runtime files");
      await this.migrateAndHydrateJobRuntimeFiles();
      logJobsStartupStep("Maintenance", "hydrate runtime from cloud");
      await this.hydrateJobRuntimeFromCloud();
      logJobsStartupStep("Maintenance", "backfill app ids (pass 1)");
      await this.backfillJobAppIds();
      logJobsStartupStep("Maintenance", "prune stale entries");
      await this.pruneStaleJobEntries();
      logJobsStartupStep("Maintenance", "install default jobs");
      await this.installDefaultJobs();
      logJobsStartupStep("Maintenance", "install workspace chat job");
      await this.installWorkspaceChatJob();
      logJobsStartupStep("Maintenance", "sync Home Daily Brief bundle");
      await this.syncHomeDailyBriefFromBundle();
      logJobsStartupStep("Maintenance", "reconcile duplicate Home Daily Brief");
      await this.reconcileDuplicateHomeDailyBriefJobsIfNeeded();
      logJobsStartupStep("Maintenance", "filter tombstones after hydrate");
      await this.filterTombstonedJobsFromRegistry();
      logJobsStartupStep("Maintenance", "backfill app ids (pass 2)");
      await this.backfillJobAppIds();
      logJobsStartupStep("Maintenance", "migrate unlinked jobs");
      await this.migrateUnlinkedJobsToLocalOnly();

      void this.rebuildGraph();

      const elapsedMs = Math.round(performance.now() - startedAt);
      if (process.env.PAPR_DEBUG_STARTUP === "1") {
        console.log(
          `[JobsService] Startup maintenance complete (${this.jobs.size} jobs, ${elapsedMs}ms)`,
        );
      }

      if (this.deferredDeleteCloudPush) {
        this.deferredDeleteCloudPush = false;
        void this.flushDeferredDeleteCloudPush();
      }
    } catch (err) {
      console.warn(
        "[JobsService] Startup maintenance error:",
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
  }

  /** Await background migrations before home repair, bundled jobs, or scheduler start. */
  async waitForStartupMaintenance(): Promise<void> {
    if (this.startupMaintenancePromise) {
      await this.startupMaintenancePromise;
    }
  }

  private voidDeleteJobCloudArtifacts(
    jobId: string,
    options?: { skipWorkspacePush?: boolean },
  ): void {
    void import("./jobs/jobCloudCleanup.js")
      .then(({ deleteJobCloudArtifacts }) =>
        deleteJobCloudArtifacts(jobId, options),
      )
      .catch((err) => {
        console.warn(
          `[JobsService] Cloud cleanup failed for ${jobId}:`,
          err instanceof Error ? err.message.slice(0, 120) : err,
        );
      });
  }

  private async flushDeferredDeleteCloudPush(): Promise<void> {
    const { waitForWorkspaceReady } = await import("./workspaceReadiness.js");
    await waitForWorkspaceReady();
    if (!this.isWriteContextValid("deferred job delete cloud push")) {
      return;
    }
    try {
      const { getCloudSyncService } = await import("./CloudSyncService.js");
      const cloudSync = getCloudSyncService();
      if (cloudSync) {
        await cloudSync.pushNow();
      }
    } catch (err) {
      console.warn(
        "[JobsService] Deferred cloud push after startup job deletes failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Infer appIds for legacy jobs missing the field (data-sources + folder title match).
   * Jobs with no linkage get STANDALONE_APP_ID.
   */
  private async migrateLegacyHomeDailyBriefJobIfNeeded(): Promise<void> {
    try {
      const { migrateLegacyHomeDailyBriefJobIfNeeded } = await import(
        "./migrateLegacyHomeDailyBriefJob.js"
      );
      const result = await migrateLegacyHomeDailyBriefJobIfNeeded({
        paprDir: getPaprRoot(),
        appsDir: getPaprAppsRoot(),
        jobsRoot: this.jobsRootDir,
        jobs: this.jobs,
        saveJobs: () => this.saveJobs(),
        persistJobRecord: (job) => this.persistJobRecord(job),
      });
      if (result.migrated && result.fromJobId && result.toJobId) {
        notifyJobOwnershipChanged(getPaprRoot());
        console.log(
          `[JobsService] Migrated legacy Home Daily Brief job ${result.fromJobId} → ${result.toJobId}`,
        );
      }
    } catch (err) {
      console.warn(
        "[JobsService] Legacy Home Daily Brief migration failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Remove duplicate Daily Brief jobs re-introduced by cloud/git sync. */
  private async reconcileDuplicateHomeDailyBriefJobsIfNeeded(): Promise<void> {
    try {
      const { reconcileDuplicateHomeDailyBriefJobs } = await import(
        "./migrateLegacyHomeDailyBriefJob.js"
      );
      const result = await reconcileDuplicateHomeDailyBriefJobs({
        paprDir: getPaprRoot(),
        appsDir: getPaprAppsRoot(),
        jobsRoot: this.jobsRootDir,
        jobs: this.jobs,
        saveJobs: () => this.saveJobs(),
        persistJobRecord: (job) => this.persistJobRecord(job),
        deleteJob: async (jobId) => {
          await this.deleteJob(jobId, true, false, { deferCloudCleanup: true });
        },
      });
      if (result.reconciled && result.removedJobIds.length > 0) {
        notifyJobOwnershipChanged(getPaprRoot());
        console.log(
          `[JobsService] Reconciled duplicate Home Daily Brief jobs → kept ${result.canonicalJobId}, removed [${result.removedJobIds.join(", ")}]`,
        );
      }
    } catch (err) {
      console.warn(
        "[JobsService] Duplicate Home Daily Brief reconciliation failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async backfillJobAppIds(): Promise<void> {
    let changed = false;
    const jobIdToAppIds = new Map<string, Set<string>>();

    try {
      const { getAppService } = await import("./AppService.js");
      const appService = getAppService();
      if (!appService.isInitialized()) {
        return;
      }
      const apps = await appService.listApps();

      for (const app of apps) {
        try {
          const dataSources = await appService.listAppDataSources(app.id);
          for (const ds of dataSources) {
            if (!ds.jobId) {
              continue;
            }
            const set = jobIdToAppIds.get(ds.jobId) ?? new Set<string>();
            set.add(app.id);
            jobIdToAppIds.set(ds.jobId, set);
          }
        } catch {
          // app has no data-sources file yet
        }

        const appTitleLower = app.title.toLowerCase();
        for (const job of this.jobs.values()) {
          if (job.folder && job.folder.toLowerCase() === appTitleLower) {
            const set = jobIdToAppIds.get(job.id) ?? new Set<string>();
            set.add(app.id);
            jobIdToAppIds.set(job.id, set);
          }
        }
      }
    } catch {
      // AppService unavailable during early startup
    }

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.appIds?.length) continue;

      const inferred = jobIdToAppIds.get(jobId);
      const appIds =
        inferred && inferred.size > 0
          ? [...inferred]
          : [STANDALONE_APP_ID];

      this.jobs.set(jobId, { ...job, appIds });
      changed = true;

      try {
        await this.persistJobRecord({ ...job, appIds });
      } catch {
        // job dir may be missing
      }
    }

    if (changed) {
      await this.saveJobs();
      notifyJobOwnershipChanged(getPaprRoot());
      console.log("[JobsService] Backfilled appIds on legacy jobs");
    }
  }

  /** Add an app id to a job if missing (e.g. after link_app_data_source). */
  async ensureJobLinkedToApp(jobId: string, appId: string): Promise<void> {
    if (!appId || appId === STANDALONE_APP_ID) return;
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (jobBelongsToApp(job.appIds, appId)) return;

    const appIds = mergeJobAppIds(job.appIds, [appId]);
    await this.updateJob(jobId, { appIds });
  }

  private async validateAppIdsExist(appIds: string[]): Promise<void> {
    const realAppIds = appIds.filter((id) => id !== STANDALONE_APP_ID);
    if (realAppIds.length === 0) return;

    const { getAppService } = await import("./AppService.js");
    const appService = getAppService();
    await appService.initialize();

    for (const appId of realAppIds) {
      const app = await appService.getApp(appId);
      if (!app) {
        throw new Error(
          `App not found: ${appId}. Use list_apps() to get valid app UUIDs.`,
        );
      }
    }
  }

  private async loadJobs(): Promise<void> {
    try {
      const raw = await fs.readFile(this.jobsIndexPath, "utf8");
      const jobs = JSON.parse(raw) as JobRecord[];
      this.jobs = new Map(jobs.map((job) => [job.id, job]));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        this.jobs = new Map();
        return;
      }
      console.error("[JobsService] Failed to load jobs:", error);

      // File exists but is corrupted (truncated write, etc.) — start empty; restore from backup manually.
      try {
        const backupPath = this.jobsIndexPath + `.corrupt-${Date.now()}`;
        await fs.copyFile(this.jobsIndexPath, backupPath);
        console.warn(`[JobsService] Backed up corrupt jobs.json to ${backupPath}`);
      } catch {
        // backup failed — not critical
      }
      this.jobs = new Map();
    }
  }

  /**
   * Remove index entries whose job directories no longer exist on disk.
   * Handles cases where a job folder was deleted externally (e.g. bash rm -rf).
   */
  private async pruneStaleJobEntries(): Promise<void> {
    const staleIds: string[] = [];
    for (const jobId of this.jobs.keys()) {
      const jobDir = path.join(this.jobsRootDir, jobId);
      try {
        const stat = await fs.stat(jobDir);
        if (!stat.isDirectory()) {
          staleIds.push(jobId);
          continue;
        }
        const files = await fs.readdir(jobDir);
        if (files.length === 0) {
          staleIds.push(jobId);
        }
      } catch {
        staleIds.push(jobId);
      }
    }

    if (staleIds.length === 0) return;

    for (const id of staleIds) {
      this.running.delete(id);
      this.jobs.delete(id);
      console.log(`[JobsService] Pruned stale job index entry (folder missing or empty): ${id}`);
    }
    await this.saveJobs();
  }

  /**
   * Reload jobs from disk, picking up any manual edits to jobs.json.
   * Useful when agent or user manually fixes job status on disk.
   */
  async reloadJobs(): Promise<void> {
    console.log("[JobsService] Reloading jobs from disk...");
    await this.loadJobs();
    await this.hydrateJobsFromRuntimeFiles();
    await this.pruneStaleJobEntries();
    await this.reconcileRegistryAfterSync();
    console.log(`[JobsService] Reloaded ${this.jobs.size} jobs from disk`);

    void import("./JobsScheduler.js")
      .then(({ getJobsScheduler }) => {
        getJobsScheduler().requestReschedule();
      })
      .catch(() => {});
  }

  /** Drop tombstoned job IDs re-introduced by git/metadata merge. */
  async filterTombstonedJobsFromRegistry(
    paprDir: string = this.boundPaprDir ?? getPaprRoot(),
  ): Promise<number> {
    const { readJobTombstones } = await import("./jobs/jobTombstones.js");
    const tombstones = await readJobTombstones(paprDir);
    if (tombstones.size === 0) {
      return 0;
    }

    const removed: string[] = [];
    for (const jobId of tombstones) {
      if (this.jobs.has(jobId)) {
        this.jobs.delete(jobId);
        removed.push(jobId);
      }
    }

    if (removed.length > 0) {
      await this.saveJobs();
      console.log(
        `[JobsService] Removed ${removed.length} tombstoned job(s) from registry: [${removed.join(", ")}]`,
      );
    }
    return removed.length;
  }

  /** After cloud/git sync — dedupe Home Daily Brief, repair links, respect tombstones. */
  async reconcileRegistryAfterSync(): Promise<{
    tombstonesRemoved: number;
    duplicatesReconciled: boolean;
    duplicateIdsRemoved: string[];
  }> {
    if (!this.isWriteContextValid("jobs registry reconcile")) {
      return {
        tombstonesRemoved: 0,
        duplicatesReconciled: false,
        duplicateIdsRemoved: [],
      };
    }

    const paprDir = this.boundPaprDir ?? getPaprRoot();
    const tombstonesRemoved = await this.filterTombstonedJobsFromRegistry(paprDir);
    const { reconcileDuplicateHomeDailyBriefJobs } = await import(
      "./migrateLegacyHomeDailyBriefJob.js"
    );
    const reconcile = await reconcileDuplicateHomeDailyBriefJobs({
      paprDir,
      appsDir: path.join(paprDir, "apps"),
      jobsRoot: this.jobsRootDir,
      jobs: this.jobs,
      saveJobs: () => this.saveJobs(),
      persistJobRecord: (job) => this.persistJobRecord(job),
      deleteJob: async (jobId) => {
        await this.deleteJob(jobId, true, false);
      },
    });

    try {
      const { getAppService } = await import("./AppService.js");
      await getAppService().repairHomeAndWorkspaceOnStartup();
    } catch (err) {
      console.warn(
        "[JobsService] Home repair after sync failed:",
        (err as Error).message.slice(0, 120),
      );
    }

    return {
      tombstonesRemoved,
      duplicatesReconciled: reconcile.reconciled,
      duplicateIdsRemoved: reconcile.removedJobIds,
    };
  }

  private async saveJobs(): Promise<void> {
    if (!this.isWriteContextValid("jobs.json save")) {
      return;
    }
    // Wait for any in-flight save to complete
    if (this.saveLock) {
      await this.saveLock;
    }

    // Create new save promise
    this.saveLock = (async () => {
      try {
        const list = Array.from(this.jobs.values())
          .sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          )
          .map((job) => toConfigIndexEntry(job));
        const data = JSON.stringify(list, null, 2);

        // Use timestamp + random suffix to ensure unique temp file
        const tmpPath =
          this.jobsIndexPath +
          `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        await fs.writeFile(tmpPath, data, "utf8");
        await fs.rename(tmpPath, this.jobsIndexPath);

        const updatedAt = new Date().toISOString();
        void import("./syncV3/MetadataRegistryClient.js")
          .then(({ uploadJobsIndexToCloud }) =>
            uploadJobsIndexToCloud(list, updatedAt),
          )
          .catch((err: Error) => {
            console.warn(
              "[JobsService] jobs index cloud upload failed:",
              err.message.slice(0, 120),
            );
          });
      } finally {
        // Clear lock after save completes or fails
        this.saveLock = null;
      }
    })();

    // Wait for this save to complete
    await this.saveLock;
  }

  private async persistJobRecord(job: JobRecord): Promise<void> {
    if (!this.isWriteContextValid(`job record ${job.id}`)) {
      return;
    }
    const jobDir = this.getJobDir(job.id);
    await fs.mkdir(jobDir, { recursive: true });
    const { config, runtime } = splitJobRecord(job);
    await writeJsonAtomic(path.join(jobDir, "job.json"), config);
    await writeJsonAtomic(path.join(jobDir, JOB_RUNTIME_FILE_NAME), runtime);
  }

  /**
   * Merge gitignored runtime files into in-memory jobs (runtime-off-git reload path).
   */
  private async hydrateJobsFromRuntimeFiles(): Promise<void> {
    for (const jobId of this.jobs.keys()) {
      const merged = await this.readMergedJobRecordFromDisk(jobId);
      if (merged) {
        this.jobs.set(jobId, merged);
      }
    }
  }

  private async readMergedJobRecordFromDisk(
    jobId: string,
  ): Promise<JobRecord | null> {
    const jobDir = path.join(this.jobsRootDir, jobId);
    const jobJsonPath = path.join(jobDir, "job.json");
    const runtimePath = path.join(jobDir, JOB_RUNTIME_FILE_NAME);

    let raw: Record<string, unknown>;
    try {
      const jobJsonText = await fs.readFile(jobJsonPath, "utf8");
      const parsed = parseJsonTolerant<Record<string, unknown>>(jobJsonText);
      if (!parsed) {
        return null;
      }
      raw = parsed;
    } catch {
      return null;
    }

    let runtimeRaw: Partial<JobRecord> | null = null;
    try {
      const runtimeText = await fs.readFile(runtimePath, "utf8");
      runtimeRaw = parseJsonTolerant<Partial<JobRecord>>(runtimeText) ?? null;
    } catch {
      // no runtime file yet
    }

    const { config, runtime } = parseMonolithicJobJson(raw);
    const mergedRuntime = { ...runtime, ...runtimeRaw };
    const configBase = {
      ...config,
      id: jobId,
      name: typeof config.name === "string" ? config.name : jobId,
      type: (config.type as JobType) ?? "bash",
      appIds: Array.isArray(config.appIds)
        ? config.appIds
        : [STANDALONE_APP_ID],
      createdAt:
        typeof config.createdAt === "string"
          ? config.createdAt
          : new Date().toISOString(),
    };

    return mergeJobConfigAndRuntime(configBase, mergedRuntime);
  }

  /**
   * Split monolithic job.json into config + gitignored runtime files; hydrate memory from disk.
   */
  private async migrateAndHydrateJobRuntimeFiles(): Promise<void> {
    let migrated = 0;
    try {
      const paprDir = getPaprRoot();
      const { readJobTombstones } = await import("./jobs/jobTombstones.js");
      const tombstones = await readJobTombstones(paprDir);
      const { readMigrationMarker, shouldSkipDailyBriefJobDirRecovery } =
        await import("./migrateLegacyHomeDailyBriefJob.js");
      const homeMigrationMarker = await readMigrationMarker(paprDir);

      const dirs = await fs.readdir(this.jobsRootDir);
      for (const dirName of dirs) {
        if (shouldSkipDailyBriefJobDirRecovery(dirName, homeMigrationMarker)) {
          continue;
        }

        const jobDir = path.join(this.jobsRootDir, dirName);
        try {
          const stat = await fs.stat(jobDir);
          if (!stat.isDirectory()) continue;
        } catch {
          continue;
        }

        const jobJsonPath = path.join(jobDir, "job.json");
        const runtimePath = path.join(jobDir, JOB_RUNTIME_FILE_NAME);
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(
            await fs.readFile(jobJsonPath, "utf8"),
          ) as Record<string, unknown>;
        } catch {
          continue;
        }

        const jobId =
          typeof raw.id === "string" && raw.id.length > 0 ? raw.id : dirName;
        if (tombstones.has(jobId)) {
          continue;
        }
        let runtimeRaw: Partial<JobRecord> | null = null;
        try {
          runtimeRaw = JSON.parse(
            await fs.readFile(runtimePath, "utf8"),
          ) as Partial<JobRecord>;
        } catch {
          // no runtime file yet
        }

        const { config, runtime } = parseMonolithicJobJson(raw);
        const mergedRuntime = { ...runtime, ...runtimeRaw };
        const needsSplit = recordHasRuntimeFields(raw);

        const configBase = {
          ...config,
          id: jobId,
          name: typeof config.name === "string" ? config.name : jobId,
          type: (config.type as JobType) ?? "bash",
          appIds: Array.isArray(config.appIds)
            ? config.appIds
            : [STANDALONE_APP_ID],
          createdAt:
            typeof config.createdAt === "string"
              ? config.createdAt
              : new Date().toISOString(),
        };

        const merged = mergeJobConfigAndRuntime(configBase, mergedRuntime);
        this.jobs.set(jobId, merged);

        if (needsSplit || !runtimeRaw) {
          await this.persistJobRecord(merged);
          if (needsSplit) migrated++;
        }
      }
    } catch (err) {
      console.warn(
        "[JobsService] Job runtime migration skipped:",
        (err as Error).message.slice(0, 120),
      );
    }

    if (migrated > 0) {
      await this.saveJobs();
      console.log(
        `[JobsService] Split runtime from job.json for ${migrated} job(s)`,
      );
    }
  }

  /**
   * Apply cloud runtime patch from heartbeat (LWW on recordedAt vs local updatedAt).
   */
  async applyCloudRunPatch(patch: JobRuntimePatch): Promise<JobRecord | null> {
    const job = this.jobs.get(patch.jobId);
    if (!job) {
      console.warn(
        `[JobsService] Ignoring cloud patch for unknown job: ${patch.jobId}`,
      );
      return null;
    }

    const recordedAt = patch.recordedAt?.trim() || new Date().toISOString();
    const patchMs = new Date(recordedAt).getTime();
    const localMs = new Date(job.updatedAt).getTime();
    if (
      Number.isFinite(patchMs) &&
      Number.isFinite(localMs) &&
      patchMs <= localMs
    ) {
      return null;
    }

    const status = parseJobStatus(patch.status);
    const updates: Partial<JobRecord> = {};
    if (patch.lastRunAt !== undefined) updates.lastRunAt = patch.lastRunAt;
    if (patch.completedAt !== undefined) updates.completedAt = patch.completedAt;
    if (patch.exitCode !== undefined) updates.exitCode = patch.exitCode;
    if (patch.error !== undefined) updates.error = patch.error ?? undefined;
    if (patch.lastOutput !== undefined) updates.lastOutput = patch.lastOutput;
    if (patch.scheduleState !== undefined) {
      updates.scheduleState = patch.scheduleState;
    }
    if (patch.source) {
      updates.lastRunSource = patch.source;
    }

    return this.setJobStatus(job.id, status, updates, {
      updatedAt: recordedAt,
      fromCloudPatch: true,
    }).then(async (updated) => {
      if (!updated) {
        return updated;
      }
      const terminal =
        status === "completed" || status === "failed" || status === "cancelled";
      if (terminal && patch.source?.startsWith("cloud")) {
        await this.handleCloudRunCompletion(updated, patch, status);
      }
      return this.jobs.get(job.id) ?? updated;
    });
  }

  private async handleCloudRunCompletion(
    job: JobRecord,
    patch: JobRuntimePatch,
    status: JobStatus,
  ): Promise<void> {
    const runId = `${job.id}-cloud-${Date.parse(patch.recordedAt) || Date.now()}`;
    const completedAt = patch.completedAt ?? patch.recordedAt;

    try {
      const runHistory = getJobRunHistory();
      await runHistory.appendRun({
        runId,
        jobId: job.id,
        status: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed",
        startedAt: patch.lastRunAt ?? patch.recordedAt,
        completedAt,
        exitCode: patch.exitCode,
        error: patch.error ?? undefined,
        attempt: 1,
        maxAttempts: 1,
      });
    } catch (err) {
      console.warn(
        `[JobsService] Cloud run history append failed for ${job.id}:`,
        (err as Error).message.slice(0, 120),
      );
    }

    try {
      const bridge = (await import("./TursoSyncBridge.js")).getTursoSyncBridge();
      if (bridge) {
        await bridge.pullJob(job.id);
      }
    } catch (err) {
      console.warn(
        `[JobsService] Turso pull after cloud run failed for ${job.id}:`,
        (err as Error).message.slice(0, 120),
      );
    }

    if (status !== "completed") {
      return;
    }

    const contractOutcome = await this.runDataContractValidation(job);
    if (contractOutcome && !contractOutcome.result.passed) {
      const label = contractOutcome.enforceOnFailure ? "FAILED" : "WARNING";
      await this.appendLog(
        job.id,
        `[Contract] ${label} (cloud): ${contractOutcome.result.summary}`,
      );
      if (contractOutcome.enforceOnFailure) {
        await this.setJobStatus(job.id, "failed", {
          exitCode: 1,
          error: contractOutcome.result.summary,
          lastOutput: patch.lastOutput,
          lastExecutionId: runId,
        }, { fromCloudPatch: true });
        return;
      }
    }

    if (job.recipe?.enabled && job.recipe?.autoEvaluate) {
      void this.runRecipeEvaluation(job, runId).catch((err) => {
        console.error(
          `[JobsService] Cloud recipe evaluation failed for ${job.id}:`,
          err,
        );
      });
    }
  }

  /**
   * Pull newer runtime patches from Mongo on startup (multi-device hydration).
   */
  private async hydrateJobRuntimeFromCloud(): Promise<void> {
    try {
      const { fetchCloudJobRuntimePatches } = await import(
        "./jobs/jobRuntimeCloudUpload.js"
      );
      const patches = await fetchCloudJobRuntimePatches();
      if (patches.length === 0) {
        return;
      }
      let applied = 0;
      for (const patch of patches) {
        if (!this.jobs.has(patch.jobId)) {
          continue;
        }
        const result = await this.applyCloudRunPatch(patch);
        if (result) {
          applied += 1;
        }
      }
      if (applied > 0) {
        console.log(
          `[JobsService] Hydrated ${applied} job runtime patch(es) from cloud`,
        );
      }
    } catch (err) {
      console.warn(
        "[JobsService] Cloud runtime hydrate failed:",
        (err as Error).message.slice(0, 120),
      );
    }
  }

  private getJobDir(jobId: string): string {
    return path.join(this.jobsRootDir, jobId);
  }

  getJobsRootPath(): string {
    return this.jobsRootDir;
  }

  hasJob(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  async getJobPath(jobId: string): Promise<string | null> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    return this.getJobDir(job.id);
  }

  async getJobDatabasePath(jobId: string): Promise<string | null> {
    const jobPath = await this.getJobPath(jobId);
    if (!jobPath) {
      return null;
    }
    return path.join(jobPath, "data", "data.db");
  }

  private getJobLogPath(jobId: string): string {
    return path.join(this.getJobDir(jobId), "logs", "run.log");
  }

  private async pruneJobLog(jobId: string): Promise<void> {
    const logPath = this.getJobLogPath(jobId);
    try {
      const stats = await fs.stat(logPath);
      const maxBytes = 2_000_000; // 2MB threshold
      const keepLines = 2000; // Keep last 2000 lines

      if (stats.size > maxBytes) {
        const content = await fs.readFile(logPath, "utf8");
        const lines = content.split("\n");
        
        if (lines.length > keepLines) {
          const keep = lines.slice(-keepLines);
          await fs.writeFile(logPath, keep.join("\n"), "utf8");
          console.log(
            `[JobsService] Pruned log for job ${jobId} to ${keepLines} lines (was ${lines.length})`,
          );
        }
      }
    } catch (error) {
      // Log file might not exist yet, that's okay
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[JobsService] Failed to prune log for job ${jobId}:`, error);
      }
    }
  }

  async listJobs(filter?: {
    folder?: string;
    appId?: string;
  }): Promise<JobRecord[]> {
    await this.pruneStaleJobEntries();
    let jobs = Array.from(this.jobs.values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    if (filter?.folder) {
      jobs = jobs.filter((j) => j.folder === filter.folder);
    }

    if (filter?.appId) {
      jobs = jobs.filter((j) => jobBelongsToApp(j.appIds, filter.appId!));
    }

    return jobs.filter((job) => !isWorkspaceChatJob(job.id));
  }

  /** Returns sorted list of distinct folder labels across all jobs. */
  async listJobFolders(): Promise<string[]> {
    const folders = new Set<string>();
    for (const job of this.jobs.values()) {
      if (job.folder) folders.add(job.folder);
    }
    return [...folders].sort();
  }

  /** Returns the current job-graph.json. Rebuilds from scratch if missing. */
  async getJobGraph(): Promise<JobGraph | null> {
    try {
      const raw = await fs.readFile(this.graphPath, "utf8");
      return JSON.parse(raw) as JobGraph;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        await this.rebuildGraph();
        try {
          const raw = await fs.readFile(this.graphPath, "utf8");
          return JSON.parse(raw) as JobGraph;
        } catch {
          return null;
        }
      }
      throw error;
    }
  }

  /**
   * Rebuilds ~/Papr/data/job-graph.json from current jobs + app data-sources.
   * Called fire-and-forget after every job mutation.
   */
  private async rebuildGraph(): Promise<void> {
    try {
      const jobs = Array.from(this.jobs.values());

      const folders: Record<string, string[]> = {};
      for (const job of jobs) {
        if (job.folder) {
          folders[job.folder] ??= [];
          folders[job.folder].push(job.id);
        }
      }

      const edges: JobGraphEdge[] = [];
      for (const job of jobs) {
        // Add dependency edges (solid arrows)
        for (const dep of job.dependsOn ?? []) {
          edges.push({
            from: dep.jobId,
            to: job.id,
            onStatus: dep.onStatus,
            ...(dep.autoTrigger ? { autoTrigger: true } : {}),
          });
        }
        // Add runtime call edges (dashed arrows)
        for (const calleeId of job.runtimeCalls ?? []) {
          edges.push({
            from: job.id,
            to: calleeId,
            onStatus: "completed",
            isRuntimeCall: true,
          });
        }
      }

      const appLinks: Record<string, JobGraphAppLink> = {};
      try {
        const { getAppService } = await import("./AppService.js");
        const appService = getAppService();
        await appService.initialize();
        const apps = await appService.listApps();
        for (const app of apps) {
          const linkedJobIds = new Set<string>();

          for (const job of jobs) {
            if (jobBelongsToApp(job.appIds, app.id)) {
              linkedJobIds.add(job.id);
            }
          }

          // Legacy fallback: explicit data-sources (also syncs appIds onto jobs)
          try {
            const dataSources = await appService.listAppDataSources(app.id);
            for (const ds of dataSources) {
              if (!ds.jobId) {
                continue;
              }
              linkedJobIds.add(ds.jobId);
              void this.ensureJobLinkedToApp(ds.jobId, app.id).catch((err) => {
                console.warn(
                  `[JobsService] Failed to sync appId onto job ${ds.jobId}:`,
                  err,
                );
              });
            }
          } catch {
            // skip apps with no data sources
          }

          if (linkedJobIds.size > 0) {
            appLinks[app.id] = { name: app.title, jobIds: [...linkedJobIds] };
          }

          if (process.env.PAPR_AUTO_DISCOVER_DATA_SOURCES === "true") {
            void appService.autoDiscoverDataSources(app.id).catch((err) => {
              console.warn(`[JobsService] Auto-discovery failed for app ${app.id}:`, err);
            });
          }
        }
      } catch {
        // AppService not yet initialized — skip app links this rebuild
      }

      const graph: JobGraph = {
        version: 1,
        updatedAt: new Date().toISOString(),
        folders,
        appLinks,
        edges,
      };

      if (!this.isWriteContextValid("job-graph.json save")) {
        return;
      }

      await fs.mkdir(path.dirname(this.graphPath), { recursive: true });
      await fs.writeFile(
        this.graphPath,
        JSON.stringify(graph, null, 2),
        "utf8",
      );
    } catch (error) {
      console.warn("[JobsService] Failed to rebuild graph:", error);
    }
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ?? null;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async validateJobArchitecture(jobId: string): Promise<JobArchitectureIssue[]> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return this.validateJobCandidate(job, job.id);
  }

  private async loadAppDataContract(appId: string): Promise<AppDataContract | null> {
    const contractPath = path.join(getPaprAppsRoot(), appId, "data-contract.json");
    try {
      return JSON.parse(await fs.readFile(contractPath, "utf8")) as AppDataContract;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`Invalid data contract for app ${appId}: ${String(error)}`);
    }
  }

  private async validateJobCandidate(
    job: Pick<
      JobRecord,
      "type" | "command" | "appIds" | "writeDbIds" | "recipe"
    >,
    currentJobId?: string,
  ): Promise<JobArchitectureIssue[]> {
    const issues = validateJobArchitecture(job);
    const linkedAppId = job.appIds?.find((id) => id !== STANDALONE_APP_ID);
    if (!linkedAppId) return issues;

    const contract = await this.loadAppDataContract(linkedAppId);
    const appDataIntent =
      /\$\{?(?:PAPR_DB_|APP_DB)\}?|\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(
        job.command ?? "",
      );
    const siblingJobs = [...this.jobs.values()].filter(
      (candidate) =>
        candidate.id !== currentJobId && candidate.appIds?.includes(linkedAppId),
    );
    if (appDataIntent && siblingJobs.length > 0 && !contract) {
      issues.push({
        rule: "multi-job-data-contract-required",
        severity: "warning",
        message: `App ${linkedAppId} has multiple jobs sharing app data but no data-contract.json.`,
        remediation:
          "Add a canonical data-contract.json with required tables/columns and writer/reader ownership before adding another data-writing job.",
      });
    }
    let hasRecipe = Boolean(job.recipe?.enabled);
    if (currentJobId) {
      const { getRecipeService } = await import("./jobs/RecipeService.js");
      hasRecipe = hasRecipe && (await getRecipeService().hasRecipe(currentJobId));
    }
    if (appDataIntent && !hasRecipe) {
      issues.push({
        rule: "job-acceptance-recipe-recommended",
        severity: "warning",
        message: "App-linked data job has no active execution recipe with business-outcome assertions.",
        remediation:
          "Use write_recipe to verify the expected rows/columns changed; process completion alone is not product success.",
      });
    }

    if (appDataIntent && (job.writeDbIds ?? []).length === 0) {
      issues.push({
        rule: "job-write-dbids-recommended",
        severity: "warning",
        message:
          "Job appears to mutate SQLite but writeDbIds is empty. Set writeDbIds to registry dbId(s) from create_database.",
        remediation:
          "create_database → attach_database on app → create_job({ writeDbIds: [dbId] }). Use $JOB_DB for scratch only.",
      });
    }

    let writeTargets: Awaited<ReturnType<typeof resolveJobWriteTargets>> = [];
    try {
      writeTargets = await resolveJobWriteTargets(job);
    } catch (error) {
      issues.push({
        rule: "job-write-dbids-invalid",
        severity: "error",
        message: (error as Error).message,
        remediation: "Fix writeDbIds or create missing databases with create_database.",
      });
    }

    for (const target of writeTargets) {
      issues.push(
        ...validateJobAgainstAppDatabase({
          command: job.command,
          databasePath: target.dbPath,
          contract,
          jobType: job.type,
        }),
      );
    }
    return issues;
  }

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const appIds = assertCreateAppIds(input.appIds);
    await this.validateAppIdsExist(appIds);
    await validateWriteDbIdsExist(input.writeDbIds);

    const architectureIssues = await this.validateJobCandidate({
      type: input.type,
      command: input.command,
      appIds,
      writeDbIds: input.writeDbIds,
      recipe: input.recipe,
    });
    const architectureErrors = formatJobArchitectureErrors(architectureIssues);
    if (architectureErrors) {
      throw new Error(`Job architecture validation failed:\n${architectureErrors}`);
    }

    const now = new Date().toISOString();
    const id = uuidv4();
    const { defaultExecutionCapabilityForAppIds } = await import(
      "./jobs/executionCapability.js"
    );
    const job: JobRecord = {
      id,
      name: input.name,
      type: input.type,
      status: "pending",
      appIds,
      writeDbIds: input.writeDbIds,
      folder: input.folder,
      command: input.command,
      requirements: input.requirements,
      dependsOn: input.dependsOn ?? [],
      retries: input.retries ?? { maxAttempts: 1, backoffMs: 1000 },
      deliver: input.deliver,
      retentionDays: input.retentionDays ?? 14,
      schedule: input.schedule,
      scheduleState: input.schedule
        ? this.computeScheduleState(input.schedule, undefined)
        : undefined,
      subAgentId: input.subAgentId,
      delegatedBy: input.delegatedBy,
      delegationTask: input.delegationTask,
      delegationContext: input.delegationContext,
      outputMode: input.outputMode ?? "natural",
      outputSchema: input.outputSchema,
      maxTurns: input.maxTurns,
      memoryPolicy: input.memoryPolicy ?? "none",
      reportChatId: input.reportChatId,
      provider: input.provider,
      model: input.model,
      recipe: input.recipe,
      executionCapability: defaultExecutionCapabilityForAppIds(
        appIds,
        input.executionCapability,
      ),
      createdAt: now,
      updatedAt: now,
    };

    const jobDir = this.getJobDir(id);
    await fs.mkdir(path.join(jobDir, "code"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "logs"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "migrations"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "data"), { recursive: true });
    await this.jobDatabase.ensureDatabase(jobDir);
    this.jobs.set(id, job);
    await this.persistJobRecord(job);
    if (input.requirements && input.requirements.length > 0) {
      await fs.writeFile(
        path.join(jobDir, "requirements.txt"),
        input.requirements.join("\n") + "\n",
        "utf8",
      );
    }

    // Write checkpoint template if requested
    if (
      input.useCheckpointTemplate &&
      (input.type === "python" || input.type === "node")
    ) {
      const { getWorkspaceService } = await import("./WorkspaceService.js");
      await getWorkspaceService().createCheckpointJobTemplate(
        jobDir,
        input.type,
      );
      console.log(`[JobsService] Created checkpoint template for ${id}`);
    }

    this.jobs.set(id, job);
    await this.saveJobs();
    notifyJobOwnershipChanged(getPaprRoot());
    void this.rebuildGraph();

    if (job.schedule?.enabled) {
      void import("./JobsScheduler.js")
        .then(({ getJobsScheduler }) => {
          getJobsScheduler().requestReschedule();
        })
        .catch(() => {});
    }

    getGatewayTelemetry().trackFireAndForget("paprwork_job_created", {
      job_id: id,
      job_name: input.name.length > 80 ? `${input.name.slice(0, 79)}…` : input.name,
      job_type: input.type,
      has_schedule: !!input.schedule?.enabled,
      has_dependencies: (input.dependsOn ?? []).length > 0,
      schedule_type: input.schedule?.cron ? "cron" : input.schedule?.intervalMs ? "interval" : undefined,
      // App attribution at create time answers "how many agents does this app
      // have" without needing a run to have happened yet.
      ...(() => {
        const owned = appIds.filter((id) => id !== STANDALONE_APP_ID);
        return {
          app_id: owned[0],
          app_count: owned.length,
          is_standalone: owned.length === 0,
        };
      })(),
      agent_kind: isAgentJobType(input.type) ? "agent" : "script",
      is_agent: isAgentJobType(input.type),
    });

    return job;
  }

  /**
   * Install a default/bundled job with a pre-defined ID.
   * Unlike createJob(), this accepts a full JobRecord with a fixed ID so
   * bundled apps can reference it by known ID. Skips if the job already exists.
   *
   * Optionally runs extra SQL statements against the job's data.db after creation
   * (e.g. to create application-specific tables like `briefs`).
   */
  async installDefaultJob(
    jobDef: Partial<JobRecord> & { id: string; name: string; type: JobRecord["type"] },
    extraSql?: string[],
  ): Promise<{ installed: boolean; dbPath: string }> {
    if (this.jobs.has(jobDef.id)) {
      const dbPath = path.join(this.getJobDir(jobDef.id), "data", "data.db");
      console.log(`[JobsService] Default job already exists: ${jobDef.id}`);
      return { installed: false, dbPath };
    }

    const { normalizePortableJobPrompt } = await import(
      "./jobs/normalizePortableJobPrompt.js"
    );
    const normalizedCommand = jobDef.command
      ? normalizePortableJobPrompt(jobDef.command)
      : jobDef.command;

    const now = new Date().toISOString();
    const { defaultExecutionCapabilityForAppIds } = await import(
      "./jobs/executionCapability.js"
    );
    const resolvedAppIds = jobDef.appIds?.length ? jobDef.appIds : [STANDALONE_APP_ID];
    const job: JobRecord = {
      status: "pending",
      appIds: resolvedAppIds,
      dependsOn: [],
      retries: { maxAttempts: 1, backoffMs: 1000 },
      retentionDays: 14,
      outputMode: "natural",
      memoryPolicy: "none",
      ...jobDef,
      ...(normalizedCommand ? { command: normalizedCommand } : {}),
      executionCapability: defaultExecutionCapabilityForAppIds(
        resolvedAppIds,
        jobDef.executionCapability,
      ),
      createdAt: jobDef.createdAt || now,
      updatedAt: now,
    };

    const jobDir = this.getJobDir(job.id);
    await fs.mkdir(path.join(jobDir, "code"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "logs"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "migrations"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "data"), { recursive: true });
    await this.jobDatabase.ensureDatabase(jobDir);
    await this.persistJobRecord(job);

    const dbPath = path.join(jobDir, "data", "data.db");

    if (extraSql && extraSql.length > 0) {
      let db: Database.Database | null = null;
      try {
        db = new Database(dbPath);
        for (const sql of extraSql) {
          db.exec(sql);
        }
        console.log(`[JobsService] Ran ${extraSql.length} extra SQL statement(s) for default job ${job.id}`);
      } catch (err) {
        console.warn(`[JobsService] Failed to run extra SQL for default job ${job.id}:`, err);
      } finally {
        if (db) db.close();
      }
    }

    this.jobs.set(job.id, job);
    await this.saveJobs();
    notifyJobOwnershipChanged(getPaprRoot());
    console.log(`[JobsService] Installed default job: ${job.id} - ${job.name}`);
    return { installed: true, dbPath };
  }

  /** Run data-contract validation after job completion (warn-only unless contract.enforceOnFailure). */
  private async runDataContractValidation(
    job: JobRecord,
  ): Promise<import("./DataContractService.js").ContractValidationOutcome | null> {
    try {
      const { getDataContractService } = await import(
        "./DataContractService.js"
      );
      return await getDataContractService().validateJob(job);
    } catch (err) {
      console.warn(
        `[JobsService] Data contract validation error for ${job.id}:`,
        err,
      );
      return null;
    }
  }

  /** Run recipe evaluation after job completion */
  private async runRecipeEvaluation(
    job: JobRecord,
    runId: string,
  ): Promise<void> {
    const { evaluateJobRun } = await import("./jobs/RecipeEvaluator.js");
    const logs = await this.getLogs(job.id, 32000);
    const output = job.lastOutput ?? "";

    await this.appendLog(
      job.id,
      `[Recipe] Starting evaluation for run ${runId}...`,
    );

    const evaluation = await evaluateJobRun(job, runId, output, logs);
    if (evaluation) {
      // Update job record with latest evaluation summary
      const updated = this.jobs.get(job.id);
      if (updated) {
        updated.lastEvaluation = {
          runId: evaluation.runId,
          score: evaluation.overallScore,
          passed: evaluation.passed,
          timestamp: evaluation.timestamp,
        };
        updated.updatedAt = new Date().toISOString();
        this.jobs.set(job.id, updated);
        await this.saveJobs();

        // Broadcast evaluation result to UI
        const { broadcast } = await import("../websocket/index.js");
        broadcast({
          type: "job-recipe-evaluation",
          data: {
            jobId: job.id,
            runId,
            score: evaluation.overallScore,
            passed: evaluation.passed,
            summary: evaluation.summary,
          },
        });
      }

      await this.appendLog(
        job.id,
        `[Recipe] Evaluation complete: score=${evaluation.overallScore.toFixed(2)} passed=${evaluation.passed}`,
      );
    }
  }

  private async appendLog(jobId: string, line: string): Promise<void> {
    if (!this.isWriteContextValid(`job log ${jobId}`)) {
      return;
    }
    const logPath = this.getJobLogPath(jobId);
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    try {
      await fs.appendFile(logPath, stamped, "utf8");
    } catch (err: unknown) {
      // Self-heal: if the logs/ directory was deleted or never created
      // (older jobs, manual cleanup), create it and retry once. We must
      // NEVER let a logging failure crash a job run or scheduler tick.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        try {
          await fs.mkdir(path.dirname(logPath), { recursive: true });
          await fs.appendFile(logPath, stamped, "utf8");
        } catch (retryErr) {
          console.warn(
            `[JobsService] appendLog retry failed for ${jobId}:`,
            retryErr,
          );
        }
      } else {
        console.warn(`[JobsService] appendLog failed for ${jobId}:`, err);
      }
    }

    // Prune log file if it exceeds 2MB (best-effort)
    try {
      await this.pruneJobLog(jobId);
    } catch {
      /* non-fatal */
    }

    // Broadcast log line to UI for real-time streaming
    this.broadcastJobLogLine(jobId, line);
  }

  /** Cloud agent gateway + external callers — same path as desktop job runs. */
  async appendJobRunLog(jobId: string, line: string): Promise<void> {
    await this.appendLog(jobId, line);
  }

  private async setJobStatus(
    jobId: string,
    status: JobStatus,
    updates: Partial<JobRecord> = {},
    options?: { updatedAt?: string; fromCloudPatch?: boolean },
  ): Promise<JobRecord> {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      throw new Error(`Job not found: ${jobId}`);
    }
    const now = options?.updatedAt ?? new Date().toISOString();
    const shouldTagDesktopRun =
      !options?.fromCloudPatch &&
      (status === "running" ||
        status === "completed" ||
        status === "failed" ||
        status === "cancelled");
    const next: JobRecord = {
      ...existing,
      ...updates,
      status,
      updatedAt: now,
      ...(shouldTagDesktopRun ? { lastRunSource: "desktop" } : {}),
      ...(status === "running" ? { lastRunAt: now, error: undefined } : {}),
      ...(status === "completed" ||
      status === "failed" ||
      status === "cancelled"
        ? {
            completedAt: updates.completedAt ?? now,
            lastRunAt: updates.lastRunAt ?? existing.lastRunAt ?? now,
            // Clear retry tracking on terminal states (if not overridden by updates)
            currentAttempt: updates.currentAttempt,
            maxAttempts: updates.maxAttempts,
            nextRetryAt: updates.nextRetryAt,
            currentExecutionId: updates.currentExecutionId,
          }
        : {}),
    };
    if (
      (status === "failed" || status === "cancelled") &&
      next.schedule?.enabled &&
      next.scheduleState?.currentIdempotencyKey
    ) {
      next.scheduleState = {
        ...next.scheduleState,
        currentIdempotencyKey: undefined,
      };
    }
    if (
      next.schedule?.enabled &&
      !options?.fromCloudPatch &&
      updates.scheduleState === undefined
    ) {
      next.scheduleState = this.computeScheduleState(
        next.schedule,
        next.scheduleState,
      );
    }
    this.jobs.set(jobId, next);
    await this.persistJobRecord(next);
    await this.saveJobs();

    // Broadcast job status change to all connected WebSocket clients (including mini-apps)
    this.broadcastJobStatus(next);

    if (!options?.fromCloudPatch) {
      void import("./jobs/jobRuntimeCloudUpload.js")
        .then(({ uploadJobRuntimePatch }) =>
          uploadJobRuntimePatch(jobRecordToRuntimePatch(next, "desktop")),
        )
        .catch(() => {
          /* non-fatal */
        });
    }

    // Auto-trigger downstream jobs that depend on this job with autoTrigger enabled
    if (status === "completed" || status === "failed") {
      void this.triggerDownstreamJobs(next);

      // Keep stored delegate_task tool result in sync (main agent reads chat history)
      if (next.type === "subagent" && next.reportChatId?.trim()) {
        void import("./delegationCompletionSync.js").then(
          ({ patchStoredDelegateTaskResult }) =>
            patchStoredDelegateTaskResult(next),
        );
      }

      // Wake main agent when a sub-agent delegation finishes so it can update the user
      if (next.type === "subagent" && next.reportChatId?.trim()) {
        void import("./SubAgentResponseTrigger.js")
          .then(({ triggerMainAgentOnDelegationFinished }) =>
            triggerMainAgentOnDelegationFinished(
              jobId,
              status === "completed" ? "completed" : "failed",
            ),
          )
          .catch((err) => {
            console.warn(
              `[JobsService] Delegation-finished trigger failed for ${jobId}:`,
              err,
            );
          });
      }
    }

    return next;
  }

  /**
   * Scan all jobs for ones that depend on `parentJob` with `autoTrigger: true`
   * and matching `onStatus`, then run them in the background.
   */
  private async triggerDownstreamJobs(parentJob: JobRecord): Promise<void> {
    const downstream: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      if (job.id === parentJob.id) continue;
      if (job.status === "running") continue;
      for (const dep of job.dependsOn ?? []) {
        if (
          dep.jobId === parentJob.id &&
          dep.autoTrigger === true &&
          dep.onStatus === parentJob.status
        ) {
          downstream.push(job);
          break;
        }
      }
    }
    for (const job of downstream) {
      console.log(
        `[JobsService] Auto-triggering "${job.name}" (${job.id}) — parent "${parentJob.name}" reached ${parentJob.status}`,
      );
      void this.appendLog(
        job.id,
        `Auto-triggered: dependency "${parentJob.name}" (${parentJob.id}) reached ${parentJob.status}`,
      );
      this.runJobWithDependencies(job.id, new Set<string>()).catch((error) => {
        console.error(
          `[JobsService] Auto-trigger failed for "${job.name}" (${job.id}):`,
          error,
        );
        void this.appendLog(
          job.id,
          `Auto-trigger failed: ${(error as Error).message}`,
        );
      });
    }
  }

  /**
   * Broadcast a log line for a running job. Allows chat/UI to stream logs in real time.
   * Lines starting with PAPR_PROGRESS are also emitted as jobs:progress events.
   */
  private broadcastJobLogLine(jobId: string, line: string): void {
    const hub = getJobEventHub();
    hub.publish({
      type: "jobs:log-line",
      data: { jobId, line },
    });

    const progress = parseJobProgressLine(line);
    if (progress) {
      hub.publish({
        type: "jobs:progress",
        data: toJobProgressData(jobId, progress),
      });
    }
  }

  private broadcastJobStatus(job: JobRecord): void {
    getJobEventHub().publish({
      type: "jobs:status-changed",
      data: {
        jobId: job.id,
        name: job.name,
        status: job.status,
        completedAt: job.completedAt,
        error: job.error,
        lastOutput: job.lastOutput,
        ...(job.status === "waiting_permission" && job.waitingPermissionKeys
          ? { waitingPermissionKeys: job.waitingPermissionKeys }
          : {}),
        ...(job.status === "waiting_permission" && job.waitingScheduleRisk
          ? { waitingScheduleRisk: job.waitingScheduleRisk }
          : {}),
      },
    });
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private computeScheduleState(
    schedule: JobSchedule,
    previous?: JobRecord["scheduleState"],
  ): JobRecord["scheduleState"] {
    const now = new Date();
    if (schedule.intervalMs && schedule.intervalMs > 0) {
      return {
        ...previous,
        nextRunAt: new Date(now.getTime() + schedule.intervalMs).toISOString(),
      };
    }
    if (schedule.atTime) {
      const raw = new Date(schedule.atTime);
      if (Number.isNaN(raw.getTime())) {
        return previous ?? {};
      }
      return {
        ...previous,
        nextRunAt: raw.toISOString(),
      };
    }
    if (schedule.cron) {
      if (previous?.nextRunAt) {
        return { ...previous };
      }
      const next = computeInitialNextRunAt(schedule, now, previous);
      return {
        ...previous,
        ...(next ? { nextRunAt: next } : {}),
      };
    }
    return previous ?? {};
  }

  /**
   * Ensure `nextRunAt` exists and apply misfire policy after restarts (gateway down, sleep, etc.).
   */
  private async reconcileScheduleStates(): Promise<void> {
    const now = new Date();
    for (const job of this.jobs.values()) {
      if (!job.schedule?.enabled) {
        continue;
      }
      const ss = job.scheduleState ?? {};
      let nextRunAt = ss.nextRunAt;
      let changed = false;

      if (
        !nextRunAt ||
        Number.isNaN(new Date(nextRunAt as string).getTime())
      ) {
        const computed = computeInitialNextRunAt(job.schedule, now, ss);
        if (computed) {
          nextRunAt = computed;
          changed = true;
        }
      }

      if (
        nextRunAt &&
        !Number.isNaN(new Date(nextRunAt).getTime()) &&
        new Date(nextRunAt).getTime() < now.getTime() &&
        !job.schedule.catchUpMissed
      ) {
        if (job.schedule.atTime) {
          await this.upsertJob({
            ...job,
            schedule: { ...job.schedule, enabled: false },
            scheduleState: { ...ss, nextRunAt: undefined },
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
        const bumped = computeMisfireSkipNextRunAt(job.schedule, now);
        if (bumped) {
          nextRunAt = bumped;
          changed = true;
        }
      }

      if (changed && nextRunAt) {
        await this.upsertJob({
          ...job,
          scheduleState: { ...ss, nextRunAt },
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Pin orphan / unlinked jobs to local-only so the cloud scheduler ignores them.
   * Only applies when executionCapability is unset (explicit user choice is preserved).
   */
  private async migrateUnlinkedJobsToLocalOnly(): Promise<void> {
    const jobs = Array.from(this.jobs.values());
    if (jobs.length === 0) {
      return;
    }

    const { collectLinkedJobIds } = await import("./jobs/jobAppLinkage.js");
    const { shouldDefaultUnlinkedJobToLocalOnly, UNLINKED_JOB_EXECUTION_CAPABILITY } =
      await import("./jobs/executionCapability.js");

    const linkedJobIds = await collectLinkedJobIds(jobs);
    let changed = 0;

    for (const job of jobs) {
      if (!shouldDefaultUnlinkedJobToLocalOnly(job, linkedJobIds)) {
        continue;
      }
      const updated: JobRecord = {
        ...job,
        executionCapability: UNLINKED_JOB_EXECUTION_CAPABILITY,
        updatedAt: new Date().toISOString(),
      };
      this.jobs.set(job.id, updated);
      await this.persistJobRecord(updated);
      changed += 1;
    }

    if (changed > 0) {
      await this.saveJobs();
      console.log(
        `[JobsService] Set local-only execution for ${changed} unlinked job(s)`,
      );
    }
  }

  /**
   * Thrown when a dependency is currently running.  Callers that can safely
   * defer (e.g. the scheduler) should catch this and skip the current tick
   * instead of logging a failure.
   */
  static DependencyRunningError = class extends Error {
    readonly dependencyId: string;
    constructor(dependencyId: string) {
      super(`Dependency job is already running: ${dependencyId}`);
      this.dependencyId = dependencyId;
      this.name = "DependencyRunningError";
    }
  };

  private async ensureDependencyChain(
    job: JobRecord,
    stack: Set<string>,
  ): Promise<void> {
    const dependencies = job.dependsOn ?? [];
    for (const dependency of dependencies) {
      const required = this.jobs.get(dependency.jobId);
      if (!required) {
        throw new Error(
          `Dependency job not found: ${dependency.jobId} (required by ${job.id})`,
        );
      }
      if (required.status === dependency.onStatus) {
        continue;
      }
      if (required.status === "running") {
        // Dependency is in-flight — skip this trigger and retry next tick.
        throw new JobsService.DependencyRunningError(required.id);
      }
      const dependencyResult = await this.runJobWithDependencies(
        dependency.jobId,
        stack,
      );
      if (dependencyResult.status !== dependency.onStatus) {
        throw new Error(
          `Dependency ${dependency.jobId} expected ${dependency.onStatus} but got ${dependencyResult.status}`,
        );
      }
    }
  }

  private async runSingleAttempt(
    job: JobRecord,
    runId: string,
    runtimeParams?: Record<string, string>,
  ): Promise<{ exitCode: number; errorMessage?: string; lastOutput?: string }> {
    const defaultCommandByType: Record<
      Exclude<JobType, "agent" | "subagent">,
      string
    > = {
      shell: "echo 'shell job ran successfully'",
      bash: "echo 'bash job ran successfully'",
      node: "node -e \"console.log('node job ran successfully')\"",
      python: "python3 -c \"print('python job ran successfully')\"",
      swift: "echo 'swift job scaffold is ready'",
    };
    const jobDir = this.getJobDir(job.id);
    await this.jobDatabase.ensureJobDirScaffold(jobDir);
    const appliedMigrations = await this.jobDatabase.applyMigrations(jobDir);

    const { resolveJobWriteTargets } = await import("./jobAppDatabase.js");
    const { applyRegistryDatabaseMigrations } = await import(
      "./jobs/databaseMigrations.js"
    );
    const writeTargets = await resolveJobWriteTargets(job);
    const registryMigrationSummaries: string[] = [];
    for (const target of writeTargets) {
      const appliedRegistry = await applyRegistryDatabaseMigrations(
        target.dbPath,
      );
      if (appliedRegistry.length > 0) {
        registryMigrationSummaries.push(
          `${target.alias}: ${appliedRegistry.join(", ")}`,
        );
      }
    }

    await this.jobDatabase.recordRunStart(
      jobDir,
      runId,
      job.id,
      new Date().toISOString(),
    );
    const executor = this.executors.find((item) => item.canExecute(job.type));
    if (!executor) {
      throw new Error(`No executor registered for job type: ${job.type}`);
    }
    const appendRunLog = async (line: string): Promise<void> => {
      await this.appendLog(job.id, line);
      await this.jobDatabase.appendEvent(jobDir, runId, "info", line);
      this.broadcastJobLogLine(job.id, line);
    };
    if (appliedMigrations.length > 0) {
      await appendRunLog(`Applied job scratch migrations: ${appliedMigrations.join(", ")}`);
    }
    if (registryMigrationSummaries.length > 0) {
      await appendRunLog(
        `Applied registry DB migrations: ${registryMigrationSummaries.join("; ")}`,
      );
    }

    if ((job.writeDbIds ?? []).length > 0 || writeTargets.length > 0) {
      const { pullJobTursoBeforeRun } = await import("./jobTursoSyncBookends.js");
      await pullJobTursoBeforeRun(job, appendRunLog);
    }

    const { requestKeyPermission: requestKeyPermissionFromMain } =
      await import("../permissions/PermissionRequester.js");
    const launch = await executor.launch({
      runId,
      job,
      jobDir,
      defaultCommandByType,
      appendLog: appendRunLog,
      runtimeParams,
      onWaitingPermission: async (keys: string[]) => {
        await this.setJobStatus(job.id, "waiting_permission", {
          waitingPermissionKeys: keys,
        });
        await appendRunLog(
          `Waiting for user approval for API keys: ${keys.join(", ")}`,
        );
      },
      onResumingAfterPermission: async () => {
        await this.setJobStatus(job.id, "running", {
          waitingPermissionKeys: undefined,
        });
      },
      requestKeyPermission: async (
        keyName: string,
        context: { jobId: string; jobName: string },
      ) => {
        const response = await requestKeyPermissionFromMain({
          keyName,
          description: `Job "${context.jobName}" needs ${keyName} to run.`,
          isEnvKey: false,
          toolContext: {
            toolName: "job",
            command: job.command,
          },
        });
        return response.approved;
      },
    });

    const runSanitizationValues = launch.sanitizationValues ?? [];

    // Sanitize command before logging (replace API key values with ***)
    const sanitizedCommand = await this.sanitizeCommandForLogging(
      launch.command,
      runSanitizationValues,
    );
    await appendRunLog(`Starting command: ${sanitizedCommand}`);

    if (launch.mode === "immediate") {
      if (launch.outputMessage) {
        await appendRunLog(launch.outputMessage);
      }
      if (launch.errorMessage) {
        await appendRunLog(`[stderr] ${launch.errorMessage}`);
      }
      return {
        exitCode: launch.exitCode ?? 0,
        errorMessage: launch.errorMessage,
        lastOutput: launch.outputMessage,
      };
    }

    const proc = launch.process;
    if (!proc) {
      throw new Error(
        `Executor returned process mode without process for ${job.type}`,
      );
    }
    const { stdout, stderr } = proc;
    if (!stdout || !stderr) {
      throw new Error(
        `Job process for ${job.type} must expose stdout/stderr pipes`,
      );
    }
    this.running.set(job.id, proc);

    const MAX_OUTPUT_BYTES = 32 * 1024; // 32KB cap
    const outputChunks: string[] = [];
    let outputSize = 0;

    return new Promise((resolve) => {
      let resolved = false;
      const safeResolve = (result: { exitCode: number; lastOutput?: string; errorMessage?: string }) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(watchdog);
          resolve(result);
        }
      };

      // Watchdog: kill process if it hangs for 30 minutes without completing
      const WATCHDOG_MS = 30 * 60 * 1000; // 30 minutes
      const watchdog = setTimeout(() => {
        if (this.running.has(job.id)) {
          const pid = proc.pid;
          console.warn(
            `[JobsService] Watchdog timeout for ${job.id} (pid ${pid}) after ${WATCHDOG_MS / 1000}s — killing process`,
          );
          void appendRunLog(`Watchdog timeout after ${WATCHDOG_MS / 1000}s — killing process`);
          try {
            proc.kill("SIGKILL");
          } catch { /* already dead */ }
          this.running.delete(job.id);
          safeResolve({ exitCode: -1, errorMessage: "Watchdog timeout — process killed after 30 minutes" });
        }
      }, WATCHDOG_MS);

      stdout.on("data", async (chunk: Buffer) => {
        const text = chunk.toString("utf8").trimEnd();
        // Sanitize stdout before logging
        const sanitized = await this.sanitizeCommandForLogging(
          text,
          runSanitizationValues,
        );
        void appendRunLog(sanitized);
        if (outputSize < MAX_OUTPUT_BYTES) {
          outputChunks.push(sanitized);
          outputSize += sanitized.length;
        }
      });
      stderr.on("data", async (chunk: Buffer) => {
        const text = chunk.toString("utf8").trimEnd();
        // Sanitize stderr before logging
        const sanitized = await this.sanitizeCommandForLogging(
          text,
          runSanitizationValues,
        );
        void appendRunLog(`[stderr] ${sanitized}`);
      });
      proc.on("close", (code: number | null) => {
        this.running.delete(job.id);
        const exitCode = code ?? -1;
        void appendRunLog(`Process exited with code ${exitCode}`);
        const lastOutput =
          outputChunks.join("\n").slice(0, MAX_OUTPUT_BYTES) || undefined;
        safeResolve({ exitCode, lastOutput });
      });
      proc.on("error", (error: Error) => {
        this.running.delete(job.id);
        const formatted = formatSpawnErrorForLogs(error.message);
        void appendRunLog(`Process error: ${formatted}`);
        safeResolve({ exitCode: -1, errorMessage: formatted });
      });
    });
  }

  private async runJobWithDependencies(
    jobId: string,
    stack: Set<string>,
    runtimeParams?: Record<string, string>,
    scheduledDueAt?: string,
  ): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    if (this.running.has(jobId)) {
      throw new Error("Job is already running");
    }
    if (stack.has(jobId)) {
      throw new Error(`Dependency cycle detected at job: ${jobId}`);
    }
    const architectureIssues = await this.validateJobCandidate(job, jobId);
    const architectureErrors = formatJobArchitectureErrors(architectureIssues);
    if (architectureErrors) {
      throw new Error(`Job architecture validation failed before run:\n${architectureErrors}`);
    }
    // Read before stack.add: a non-empty stack means this run was pulled in by
    // ensureDependencyChain rather than started directly. Separating chained
    // runs from human ones keeps pipeline fan-out from reading as user demand.
    const runTrigger: JobRunTrigger =
      stack.size > 0
        ? "dependency"
        : scheduledDueAt && scheduledDueAt.length > 0
          ? "scheduled"
          : "manual";
    stack.add(jobId);

    try {
      await this.ensureDependencyChain(job, stack);

      if (scheduledDueAt !== undefined && scheduledDueAt.length > 0) {
        const fresh = this.jobs.get(jobId);
        if (!fresh) {
          throw new Error(`Job not found: ${jobId}`);
        }
        if (fresh.schedule?.enabled) {
          const idempotencyKey = `${jobId}-${scheduledDueAt}`;
          if (
            fresh.scheduleState?.currentIdempotencyKey === idempotencyKey &&
            (fresh.status === "running" ||
              fresh.status === "waiting_permission")
          ) {
            await this.appendLog(
              jobId,
              `Skipping duplicate scheduled slot (already active): ${idempotencyKey}`,
            );
            return fresh;
          }
          if (
            fresh.scheduleState?.lastIdempotencyKey === idempotencyKey &&
            fresh.status === "completed"
          ) {
            await this.appendLog(
              jobId,
              `Skipping scheduled slot (already completed): ${idempotencyKey}`,
            );
            return fresh;
          }
          const triggeredAt = new Date().toISOString();
          await this.setJobStatus(jobId, fresh.status, {
            scheduleState: {
              ...fresh.scheduleState,
              lastScheduledRunAt: scheduledDueAt,
              lastTriggeredAt: triggeredAt,
              currentIdempotencyKey: idempotencyKey,
            },
          });
        }
      }

      const maxAttempts = Math.max(1, job.retries?.maxAttempts ?? 1);
      const backoffMs = Math.max(0, job.retries?.backoffMs ?? 1000);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const attemptStart = performance.now();
        const runId = `${job.id}-${Date.now()}-a${attempt}`;

        // Track execution state and retry attempts
        await this.setJobStatus(job.id, "running", {
          currentExecutionId: runId,
          currentAttempt: attempt,
          maxAttempts: maxAttempts,
          nextRetryAt: undefined, // Clear since we're running now
        });

        await this.appendLog(
          job.id,
          `[attempt ${attempt}/${maxAttempts}] Starting execution ${runId}`,
        );

        const result = await this.runSingleAttempt(job, runId, runtimeParams);
        const status: JobStatus =
          result.exitCode === 0 ? "completed" : "failed";

        // Record run in history
        const runHistory = getJobRunHistory();
        await runHistory.appendRun({
          runId,
          jobId: job.id,
          status,
          startedAt: new Date(Date.now() - (performance.now() - attemptStart)).toISOString(),
          completedAt: new Date().toISOString(),
          duration: Math.round(performance.now() - attemptStart),
          exitCode: result.exitCode,
          error: result.errorMessage,
          scheduledDueAt,
          attempt,
          maxAttempts,
        });

        // Update with execution results
        const updated = await this.setJobStatus(job.id, status, {
          exitCode: result.exitCode,
          error: result.errorMessage,
          lastOutput: result.lastOutput,
          lastExecutionId: runId,
          currentExecutionId: status === "completed" ? undefined : runId,
          currentAttempt: status === "completed" ? undefined : attempt,
          maxAttempts: status === "completed" ? undefined : maxAttempts,
        });

        await this.jobDatabase.recordRunFinish(
          this.getJobDir(job.id),
          runId,
          status,
          result.exitCode,
          result.errorMessage,
        );
        await this.jobDatabase.pruneHistory(
          this.getJobDir(job.id),
          updated.retentionDays ?? 14,
        );

        if (status === "completed") {
          // ── Data contract validation (warn-only unless enforceOnFailure in contract) ──
          const contractOutcome = await this.runDataContractValidation(updated);
          if (contractOutcome && !contractOutcome.result.passed) {
            const label = contractOutcome.enforceOnFailure ? "FAILED" : "WARNING";
            await this.appendLog(
              job.id,
              `[Contract] ${label}: ${contractOutcome.result.summary}`,
            );
            for (const violation of contractOutcome.result.violations) {
              if (violation.severity === "error") {
                await this.appendLog(job.id, `[Contract] ${violation.message}`);
              }
            }
            if (contractOutcome.enforceOnFailure) {
              return await this.setJobStatus(job.id, "failed", {
                exitCode: 1,
                error: contractOutcome.result.summary,
                lastOutput: result.lastOutput,
                lastExecutionId: runId,
                currentExecutionId: undefined,
                currentAttempt: undefined,
                maxAttempts: undefined,
              });
            }
          }
          if (contractOutcome?.result.passed) {
            await this.appendLog(
              job.id,
              `[Contract] ${contractOutcome.result.summary}`,
            );
          }

          getGatewayTelemetry().trackFireAndForget("paprwork_job_completed", {
            ...buildJobRunDimensions({
              jobId: job.id,
              jobType: job.type,
              appIds: job.appIds,
              durationMs: performance.now() - attemptStart,
              surface: "local",
              trigger: runTrigger,
              subAgentId: job.subAgentId,
            }),
            exit_code: result.exitCode,
            attempts: attempt,
            had_retry: attempt > 1,
          });

          // Sync structured job DB rows to Papr Memory (preferred over log writeback)
          void import("./JobDatabaseMemorySync.js")
            .then(({ syncJobDatabaseToMemory }) =>
              syncJobDatabaseToMemory({
                job: updated,
                runId,
                jobDir: this.getJobDir(job.id),
              }),
            )
            .then(async (result) => {
              if (result.synced) {
                await this.appendLog(
                  job.id,
                  `Synced ${result.tableCount} job database table(s) to Papr Memory`,
                );
              }
            })
            .catch((err) => {
              console.warn(
                `[JobsService] Job database memory sync failed for ${job.id}:`,
                err,
              );
            });

          void import("./jobTursoSyncBookends.js")
            .then(({ pushJobTursoIfEnabled }) => pushJobTursoIfEnabled(job))
            .catch((err) => {
              console.warn(
                `[JobsService] Turso push failed for ${job.id}:`,
                (err as Error).message.slice(0, 120),
              );
            });

          // ── Recipe Evaluation (fire-and-forget after completion) ──
          if (updated.recipe?.enabled && updated.recipe?.autoEvaluate) {
            void this.runRecipeEvaluation(updated, runId).catch((err) => {
              console.error(
                `[JobsService] Recipe evaluation failed for ${job.id}:`,
                err,
              );
            });
          }
          if (updated.scheduleState?.currentIdempotencyKey) {
            return await this.setJobStatus(job.id, status, {
              scheduleState: {
                ...updated.scheduleState,
                lastIdempotencyKey: updated.scheduleState.currentIdempotencyKey,
                currentIdempotencyKey: undefined,
              },
            });
          }
          return updated;
        }

        // For failed status, classify error to determine if we should retry
        const error = new Error(result.errorMessage ?? `Exit code ${result.exitCode}`);
        const errorType = classifyError(error);
        const errorReason = getErrorClassificationReason(error);

        await this.appendLog(job.id, `Error classification: ${errorReason}`);

        // If permanent error, don't retry
        if (errorType === "permanent") {
          await this.appendLog(
            job.id,
            `Permanent error detected. Stopping retries.`,
          );
          
          // Disable schedule for one-shot jobs with permanent errors
          if (job.schedule?.atTime) {
            await this.upsertJob({
              ...job,
              schedule: { ...job.schedule, enabled: false },
            });
            await this.appendLog(
              job.id,
              `One-shot schedule disabled due to permanent error.`,
            );
          }
          
          return updated;
        }

        // Calculate and store next retry time (for transient errors)
        if (attempt < maxAttempts) {
          const backoff = backoffMs * Math.pow(2, attempt - 1);
          const nextRetryAt = new Date(Date.now() + backoff).toISOString();

          await this.setJobStatus(job.id, "failed", {
            nextRetryAt: nextRetryAt,
          });

          await this.appendLog(
            job.id,
            `Attempt ${attempt}/${maxAttempts} failed. Next retry at ${nextRetryAt} (in ${backoff}ms)`,
          );
          await this.sleep(backoff);
        } else {
          // Final failure - clear retry tracking
          await this.appendLog(
            job.id,
            `All ${maxAttempts} attempts failed. Job marked as failed.`,
          );
          const failErr = new Error(
            result.errorMessage ?? `Exit code ${result.exitCode}`,
          );
          getGatewayTelemetry().trackFireAndForget("paprwork_job_failed", {
            ...buildJobRunDimensions({
              jobId: job.id,
              jobType: job.type,
              appIds: job.appIds,
              // Failed work still consumed time and compute. Excluding it would
              // make an agent that burns 20 minutes then errors look free.
              durationMs: performance.now() - attemptStart,
              surface: "local",
              trigger: runTrigger,
              subAgentId: job.subAgentId,
            }),
            job_name:
              job.name.length > 80 ? `${job.name.slice(0, 79)}…` : job.name,
            exit_code: result.exitCode,
            error_type: `exit_${result.exitCode}`,
            attempts: maxAttempts,
            retry_class: classifyError(failErr),
            failure_hint: truncateForTelemetryHint(result.errorMessage, 220),
          });
        }
      }

      return (await this.getJob(job.id)) as JobRecord;
    } finally {
      stack.delete(jobId);
    }
  }

  async runJob(
    jobId: string,
    runtimeParams?: Record<string, string>,
    scheduledDueAt?: string,
  ): Promise<JobRecord> {
    return this.runJobWithDependencies(
      jobId,
      new Set<string>(),
      runtimeParams,
      scheduledDueAt,
    );
  }

  /** Run on Papr Cloud (memory server) while desktop is awake — for testing cloud execution. */
  async runJobInCloud(jobId: string): Promise<JobRecord> {
    const { runJobInCloud: executeCloudJobRun } = await import(
      "./CloudJobRunService.js"
    );
    return executeCloudJobRun(this, jobId);
  }

  /**
   * @param dueAtIso - The `scheduleState.nextRunAt` value this tick is firing for (stable idempotency).
   */
  async runJobFromScheduler(
    jobId: string,
    dueAtIso: string,
  ): Promise<JobRecord> {
    const existing = await this.getJob(jobId);
    if (!existing) {
      throw new Error(`Job not found: ${jobId}`);
    }
    if (!existing.schedule?.enabled) {
      return this.runJob(jobId);
    }

    const { assessAgentJobSchedule, requiresScheduleRiskAcknowledgment } =
      await import("./jobs/agentScheduleGuard.js");
    if (requiresScheduleRiskAcknowledgment(existing.type, existing.schedule)) {
      const assessment = assessAgentJobSchedule(existing.type, existing.schedule);
      await this.setJobStatus(jobId, "waiting_permission", {
        waitingScheduleRisk: {
          intervalMinutes: assessment.intervalMinutes ?? 15,
          runsPerDay: assessment.runsPerDay ?? 96,
          message:
            assessment.message ??
            "High-frequency agent schedule requires your approval before running.",
        },
        scheduleState: {
          ...existing.scheduleState,
          pendingDueAtForApproval: dueAtIso,
        },
      });
      return (await this.getJob(jobId)) as JobRecord;
    }

    return this.runJob(jobId, undefined, dueAtIso);
  }

  async acknowledgeScheduleRisk(
    jobId: string,
    approved: boolean,
  ): Promise<JobRecord> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    if (job.status !== "waiting_permission" || !job.waitingScheduleRisk) {
      throw new Error(`Job ${jobId} is not waiting for schedule approval`);
    }

    const pendingDueAt = job.scheduleState?.pendingDueAtForApproval;

    if (!approved) {
      const updated = await this.setJobStatus(jobId, "pending", {
        waitingScheduleRisk: undefined,
        schedule: job.schedule
          ? { ...job.schedule, enabled: false }
          : job.schedule,
        scheduleState: {
          ...job.scheduleState,
          pendingDueAtForApproval: undefined,
        },
      });
      await this.appendLog(
        jobId,
        "High-frequency agent schedule denied by user — schedule disabled.",
      );
      return updated;
    }

    const now = new Date().toISOString();
    await this.setJobStatus(jobId, "pending", {
      waitingScheduleRisk: undefined,
      schedule: job.schedule
        ? {
            ...job.schedule,
            highFrequencyAcknowledgedAt: now,
          }
        : job.schedule,
      scheduleState: {
        ...job.scheduleState,
        pendingDueAtForApproval: undefined,
      },
    });

    await this.appendLog(
      jobId,
      "High-frequency agent schedule approved by user — running due slot.",
    );

    if (pendingDueAt) {
      return this.runJob(jobId, undefined, pendingDueAt);
    }
    return this.runJob(jobId);
  }

  async updateJob(
    jobId: string,
    updates: Partial<
      Pick<
        import("./jobs/types.js").JobRecord,
        | "name"
        | "appIds"
        | "writeDbIds"
        | "folder"
        | "command"
        | "requirements"
        | "dependsOn"
        | "retries"
        | "deliver"
        | "retentionDays"
        | "schedule"
        | "outputMode"
        | "outputSchema"
        | "maxTurns"
        | "memoryPolicy"
        | "reportChatId"
        | "provider"
        | "model"
        | "recipe"
        | "executionCapability"
      >
    >,
  ): Promise<import("./jobs/types.js").JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    if (job.status === "running") {
      throw new Error(
        `Cannot update job ${jobId} while it is running. Stop it first.`,
      );
    }

    if (updates.appIds !== undefined) {
      updates.appIds = assertCreateAppIds(updates.appIds);
      await this.validateAppIdsExist(updates.appIds);
    }

    if (updates.writeDbIds !== undefined) {
      await validateWriteDbIdsExist(updates.writeDbIds);
    }

    const candidate = { ...job, ...updates };
    const architectureIssues = await this.validateJobCandidate(candidate, jobId);
    const architectureErrors = formatJobArchitectureErrors(architectureIssues);
    if (architectureErrors) {
      throw new Error(`Job architecture validation failed:\n${architectureErrors}`);
    }

    if (updates.schedule !== undefined) {
      const { assessAgentJobSchedule } = await import(
        "./jobs/agentScheduleGuard.js"
      );
      const assessment = assessAgentJobSchedule(candidate.type, candidate.schedule);
      if (assessment.level !== "ok" && candidate.schedule) {
        candidate.schedule = {
          ...candidate.schedule,
          highFrequencyAcknowledgedAt: undefined,
        };
      }
    }

    const updated: import("./jobs/types.js").JobRecord = {
      ...candidate,
      updatedAt: new Date().toISOString(),
    };
    if (updates.schedule !== undefined) {
      const s = updated.schedule;
      updated.scheduleState = s?.enabled
        ? this.computeScheduleState(s, {})
        : undefined;
    }
    this.jobs.set(jobId, updated);
    await this.persistJobRecord(updated);
    await this.saveJobs();
    if (jobUpdateAffectsOwnership(updates)) {
      notifyJobOwnershipChanged(getPaprRoot());
    }
    void this.rebuildGraph();
    if (updates.schedule !== undefined) {
      void import("./JobsScheduler.js")
        .then(({ getJobsScheduler }) => {
          getJobsScheduler().requestReschedule();
        })
        .catch(() => {});
    }

    // If requirements changed, rewrite requirements.txt so next run picks them up
    if (updates.requirements !== undefined) {
      const jobDir = this.getJobDir(jobId);
      const reqPath = path.join(jobDir, "requirements.txt");
      if (updates.requirements.length > 0) {
        await fs.writeFile(
          reqPath,
          updates.requirements.join("\n") + "\n",
          "utf8",
        );
      } else {
        try {
          await fs.unlink(reqPath);
        } catch {
          // file may not exist, that's fine
        }
      }
    }

    getGatewayTelemetry().trackFireAndForget("paprwork_job_edited", {
      job_id: jobId,
      job_name: updated.name.length > 80 ? `${updated.name.slice(0, 79)}…` : updated.name,
      job_type: updated.type,
      changed_fields: Object.keys(updates).join(","),
    });

    return updated;
  }

  async deleteJob(
    jobId: string,
    deleteFiles = false,
    deleteTursoDb = false,
    options?: { deferCloudCleanup?: boolean },
  ): Promise<{ id: string; name: string; tursoDbDeleted?: boolean }> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Stop the process if it's currently running
    const proc = this.running.get(jobId);
    if (proc) {
      proc.kill("SIGTERM");
      this.running.delete(jobId);
    }

    const { preserveJobLinkedDatabasesBeforeDelete } = await import(
      "./databasePromotion.js"
    );
    await preserveJobLinkedDatabasesBeforeDelete(jobId, job);

    // Delete Turso cloud database if requested
    let tursoDbDeleted = false;
    if (deleteTursoDb) {
      try {
        const { getTursoSyncBridge } = await import("./TursoSyncBridge.js");
        const bridge = getTursoSyncBridge();
        if (bridge) {
          tursoDbDeleted = await bridge.deleteJobTursoDatabase(jobId);
          if (tursoDbDeleted) {
            console.log(`[JobsService] Deleted Turso database for job: ${jobId}`);
          }
        }
      } catch (error) {
        console.warn(`[JobsService] Could not delete Turso database for ${jobId}:`, error);
      }
    }

    // Remove from index and upload updated catalog (job absent = deleted in cloud metadata)
    this.jobs.delete(jobId);
    await this.saveJobs();
    notifyJobOwnershipChanged(getPaprRoot());
    void this.rebuildGraph();

    if (options?.deferCloudCleanup === true) {
      this.deferredDeleteCloudPush = true;
      this.voidDeleteJobCloudArtifacts(jobId, { skipWorkspacePush: true });
    } else {
      this.voidDeleteJobCloudArtifacts(jobId);
    }

    // Optionally remove the job directory (scripts, logs, scratch db)
    if (deleteFiles) {
      const jobDir = this.getJobDir(jobId);
      try {
        await fs.rm(jobDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `[JobsService] Could not remove job dir ${jobDir}:`,
          error,
        );
      }
    }

    getGatewayTelemetry().trackFireAndForget("paprwork_job_deleted", {
      job_id: job.id,
      job_name: job.name.length > 80 ? `${job.name.slice(0, 79)}…` : job.name,
      job_type: job.type,
    });

    return { id: job.id, name: job.name };
  }

  async stopJob(jobId: string): Promise<JobRecord> {
    const proc = this.running.get(jobId);
    if (!proc) {
      const existing = this.jobs.get(jobId);
      if (!existing) {
        throw new Error(`Job not found: ${jobId}`);
      }
      return existing;
    }
    proc.kill("SIGTERM");
    this.running.delete(jobId);
    await this.appendLog(jobId, "Job stopped by user");
    return this.setJobStatus(jobId, "cancelled", { exitCode: -1 });
  }

  /**
   * Reconcile jobs that were interrupted by app closure.
   * Called on startup to mark "running" jobs as failed with clear messaging.
   */
  private async reconcileInterruptedJobs(): Promise<void> {
    const now = new Date().toISOString();
    let needsSave = false;

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status === "running" || job.status === "waiting_permission") {
        const currentAttempt = job.currentAttempt ?? 1;
        const maxAttempts = job.maxAttempts ?? job.retries?.maxAttempts ?? 1;
        const retriesRemaining = maxAttempts - currentAttempt;

        console.log(
          `[JobsService] Reconciling interrupted job ${jobId} ` +
            `(attempt ${currentAttempt}/${maxAttempts}, ${retriesRemaining} retries remaining)`,
        );

        const updated = {
          ...job,
          status: "failed" as const,
          error:
            retriesRemaining > 0
              ? `Interrupted (app closed during execution). ${retriesRemaining} retries remaining - click Run to retry.`
              : "Interrupted (app closed) - all retries exhausted.",
          completedAt: retriesRemaining > 0 ? undefined : now,
          updatedAt: now,
          currentExecutionId: undefined,
          // Preserve retry state so manual re-run continues from current attempt
          currentAttempt: retriesRemaining > 0 ? currentAttempt : undefined,
          maxAttempts: retriesRemaining > 0 ? maxAttempts : undefined,
          waitingPermissionKeys: undefined,
        };

        this.jobs.set(jobId, updated);

        await this.persistJobRecord(updated);

        needsSave = true;
      }
    }

    if (needsSave) {
      await this.saveJobs();
    }
  }

  /**
   * Jobs left in `running` with no tracked child process (lost completion write, sleep,
   * or exception after the process exited). Marks them failed so schedules and updates work again.
   * Safe while a real run is in flight: {@link running} holds the job id until the process ends.
   * 
   * NOTE: Agent/subagent jobs are NOT checked here because they can legitimately run for hours.
   * They are only reconciled on app startup via reconcileInterruptedJobs().
   */
  async reconcileStaleRunningJobs(minStaleMs: number = 20_000): Promise<void> {
    const processBackedTypes: JobType[] = [
      "shell",
      "bash",
      "node",
      "python",
      "swift",
    ];
    const nowMs = Date.now();
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status !== "running") {
        continue;
      }
      
      // ONLY check process-backed jobs (they have reliable completion signals)
      if (processBackedTypes.includes(job.type)) {
        if (this.running.has(jobId)) {
          const proc = this.running.get(jobId)!;
          const pid = proc.pid;
          if (pid) {
            try {
              process.kill(pid, 0); // Signal 0 = check if process is alive
              continue; // Process is genuinely running
            } catch {
              // Process is dead but 'close' event never fired (e.g. after macOS sleep/wake)
              console.warn(
                `[JobsService] Zombie process detected for ${jobId} (pid ${pid}) — cleaning up`,
              );
              this.running.delete(jobId);
              // Fall through to stale handling below
            }
          } else {
            // No PID — process never started properly
            this.running.delete(jobId);
          }
        }
        const anchorMs = new Date(
          job.lastRunAt ?? job.updatedAt,
        ).getTime();
        if (Number.isNaN(anchorMs) || nowMs - anchorMs < minStaleMs) {
          continue;
        }
        console.warn(
          `[JobsService] Stale running job ${jobId} (no tracked process since ${job.lastRunAt ?? job.updatedAt}); marking failed`,
        );
        await this.appendLog(
          jobId,
          "Stale running state cleared: no active process was tracked (completion may not have been saved).",
        );
        await this.setJobStatus(jobId, "failed", {
          error:
            "Stale running state — the worker likely finished but Paprwork did not save completion. Check logs, then run again if needed.",
          currentExecutionId: undefined,
        });
        continue;
      }
      
      // Agent/subagent jobs are NOT checked at runtime (can run for hours)
      // They are only reconciled on app startup via reconcileInterruptedJobs()
    }
  }

  /** Jobs with an in-flight run (process-backed or agent/subagent). */
  listActiveJobs(): ActiveJobSummary[] {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.status === "running" || job.status === "waiting_permission",
      )
      .map((job) => ({
        id: job.id,
        name: job.name,
        type: job.type,
        status: job.status,
      }));
  }

  /**
   * Stop all running jobs (graceful shutdown or workspace switch).
   * Kills tracked child processes and marks every active job cancelled
   * (including agent jobs that have no ChildProcess entry).
   */
  async stopAllJobs(
    reason = "Job stopped due to app shutdown",
  ): Promise<{ stoppedCount: number }> {
    const activeJobs = this.listActiveJobs();
    const runningProcesses = Array.from(this.running.entries());

    if (activeJobs.length === 0 && runningProcesses.length === 0) {
      console.log("[JobsService] No running jobs to stop");
      return { stoppedCount: 0 };
    }

    console.log(
      `[JobsService] Stopping ${Math.max(activeJobs.length, runningProcesses.length)} active job(s)...`,
    );

    for (const [jobId, proc] of runningProcesses) {
      try {
        console.log(`[JobsService] Stopping job process ${jobId}`);
        proc.kill("SIGTERM");
        this.running.delete(jobId);
      } catch (error) {
        console.error(`[JobsService] Failed to kill job process ${jobId}:`, error);
      }
    }

    let stoppedCount = 0;
    for (const job of activeJobs) {
      try {
        await this.appendLog(job.id, reason);
        await this.setJobStatus(job.id, "cancelled", {
          error: reason,
          exitCode: -1,
          completedAt: new Date().toISOString(),
          currentExecutionId: undefined,
          waitingPermissionKeys: undefined,
        });
        stoppedCount += 1;
      } catch (error) {
        console.error(`[JobsService] Failed to stop job ${job.id}:`, error);
      }
    }

    console.log(`[JobsService] Stopped ${stoppedCount} job(s)`);
    return { stoppedCount };
  }

  async getLogs(jobId: string, maxBytes = 20000): Promise<string> {
    const logPath = this.getJobLogPath(jobId);
    try {
      const content = await fs.readFile(logPath, "utf8");
      if (content.length <= maxBytes) {
        return content;
      }
      return content.slice(content.length - maxBytes);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  /**
   * Sanitize command string for logging by replacing API key values with ***
   * CRITICAL for security - prevents key leakage in job logs
   */
  private async sanitizeCommandForLogging(
    command: string,
    knownValues: string[] = [],
  ): Promise<string> {
    const apiKeys: string[] = [...knownValues];

    // 1. Collect environment keys (from .env.local)
    const envKeys = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "PAPR_API_KEY",
    ];

    for (const keyName of envKeys) {
      const value = process.env[keyName];
      if (value && !apiKeys.includes(value)) {
        apiKeys.push(value);
      }
    }

    // 2. Only resolve custom keys referenced in this text (not all 50+ keys)
    const placeholderMatches = command.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g);
    const referencedNames = [
      ...new Set([...placeholderMatches].map((match) => match[1])),
    ].filter((name) => !envKeys.includes(name));

    if (referencedNames.length > 0) {
      try {
        const { resolveKeysViaIpc } = await import("../utils/keyResolver.js");
        const resolved = await resolveKeysViaIpc(referencedNames);
        for (const value of Object.values(resolved)) {
          if (value && !apiKeys.includes(value)) {
            apiKeys.push(value);
          }
        }
      } catch (error) {
        console.warn(
          "[JobsService] Failed to resolve referenced keys for sanitization:",
          error,
        );
      }
    }

    // 3. Sanitize command by replacing all key values with ***
    return sanitizeError(command, apiKeys);
  }

  // ===== Job File Version History =====

  private getJobFileVersionsDir(jobId: string, filename: string): string {
    const safeFilename = filename.replace(/\//g, "__");
    return path.join(this.getJobDir(jobId), ".versions", safeFilename);
  }

  async getJobFileVersionHistory(
    jobId: string,
    filename: string,
  ): Promise<Array<{ versionId: string; filename: string; timestamp: string; reason: string; preview: string }>> {
    const versionsDir = this.getJobFileVersionsDir(jobId, filename);

    let files: string[];
    try {
      files = await fs.readdir(versionsDir);
    } catch {
      return [];
    }

    const versions = files
      .map((f) => {
        const firstUnderscore = f.indexOf("_");
        const reason = firstUnderscore >= 0 ? f.slice(firstUnderscore + 1) : "auto";
        return {
          versionId: f,
          filename,
          timestamp: jobVersionIdToTimestamp(f),
          reason,
          preview: "",
        };
      })
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );

    for (const v of versions.slice(0, 20)) {
      try {
        const content = await fs.readFile(
          path.join(versionsDir, v.versionId),
          "utf-8",
        );
        v.preview = content.slice(0, 200);
      } catch {
        /* noop */
      }
    }

    return versions;
  }

  async getJobFileVersion(
    jobId: string,
    filename: string,
    versionId: string,
  ): Promise<{ versionId: string; filename: string; timestamp: string; reason: string; preview: string; content: string } | null> {
    const versionPath = path.join(
      this.getJobFileVersionsDir(jobId, filename),
      versionId,
    );

    try {
      const content = await fs.readFile(versionPath, "utf-8");
      return {
        versionId,
        filename,
        timestamp: jobVersionIdToTimestamp(versionId),
        reason: versionId.slice(versionId.indexOf("_") + 1) || "auto",
        preview: content.slice(0, 200),
        content,
      };
    } catch {
      return null;
    }
  }

  async readJobFile(jobId: string, filename: string): Promise<string | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    const { resolveJobFilePath } = await import("./appWorkspaceFiles.js");
    const jobDir = this.getJobDir(jobId);
    const resolvedPath = resolveJobFilePath(jobDir, filename);
    if (!resolvedPath) return null;

    try {
      return await fs.readFile(resolvedPath, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      throw error;
    }
  }

  async previewJobDatabase(
    jobId: string,
    dbRelativePath: string,
    tableName?: string,
  ): Promise<{
    dbPath: string;
    tables: Array<{
      name: string;
      columns: Array<{ name: string; type: string; pk: boolean }>;
      rowCount: number;
      rows: Record<string, unknown>[];
    }>;
    selectedTable: string | null;
  }> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const { resolveJobFilePath } = await import("./appWorkspaceFiles.js");
    const jobDir = this.getJobDir(jobId);
    const dbPath = resolveJobFilePath(jobDir, dbRelativePath);
    if (!dbPath) {
      throw new Error(`Invalid database path: ${dbRelativePath}`);
    }

    const { getDbPool } = await import("./DbQueryPool.js");
    const pool = getDbPool();
    const schema = await pool.schema(dbPath);

    const hiddenTables = new Set([
      "schema_migrations",
      "job_runs",
      "job_events",
      "sqlite_sequence",
    ]);

    const userTables = schema.tables.filter(
      (table) => !hiddenTables.has(table.table),
    );

    const quoteTable = (name: string): string =>
      `"${name.replace(/"/g, '""')}"`;

    const tables = await Promise.all(
      userTables.map(async (table) => {
        const countResult = await pool.query(
          `job-preview:${jobId}`,
          dbPath,
          `SELECT COUNT(*) AS cnt FROM ${quoteTable(table.table)}`,
          [],
        );
        const rowCount = Number(countResult.rows[0]?.cnt ?? 0);
        const preview = await pool.query(
          `job-preview:${jobId}`,
          dbPath,
          `SELECT * FROM ${quoteTable(table.table)} LIMIT 50`,
          [],
        );
        return {
          name: table.table,
          columns: table.columns,
          rowCount,
          rows: preview.rows,
        };
      }),
    );

    const selectedTable =
      tableName && tables.some((table) => table.name === tableName)
        ? tableName
        : tables[0]?.name ?? null;

    return {
      dbPath,
      tables,
      selectedTable,
    };
  }

  async writeJobFile(
    jobId: string,
    filename: string,
    content: string,
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === "running") {
      throw new Error(
        `Job ${jobId} is currently running. Wait for it to finish before editing its files.`,
      );
    }

    const { resolveJobFilePath } = await import("./appWorkspaceFiles.js");
    const jobDir = this.getJobDir(jobId);
    const resolvedPath = resolveJobFilePath(jobDir, filename);
    if (!resolvedPath) return false;

    try {
      const existing = await fs.readFile(resolvedPath, "utf8");
      const safeFilename = filename.replace(/\//g, "__");
      const versionsDir = path.join(jobDir, ".versions", safeFilename);
      await fs.mkdir(versionsDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs.writeFile(
        path.join(versionsDir, `${timestamp}_auto`),
        existing,
        "utf8",
      );
    } catch {
      /* first write */
    }

    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(resolvedPath, content, { flush: true });
    return true;
  }

  async restoreJobFileVersion(
    jobId: string,
    filename: string,
    versionId: string,
  ): Promise<boolean> {
    const version = await this.getJobFileVersion(jobId, filename, versionId);
    if (!version) return false;

    const jobDir = this.getJobDir(jobId);
    const filePath = path.join(jobDir, filename);

    // Save current content as "before-restore"
    try {
      const currentContent = await fs.readFile(filePath, "utf-8");
      if (currentContent) {
        const safeFilename = filename.replace(/\//g, "__");
        const versionsDir = path.join(jobDir, ".versions", safeFilename);
        await fs.mkdir(versionsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        await fs.writeFile(
          path.join(versionsDir, `${timestamp}_before-restore`),
          currentContent,
          "utf-8",
        );
      }
    } catch {
      /* file may not exist */
    }

    // Write restored content
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, version.content, "utf-8");

    console.log(`[JobsService] Restored ${filename} to version ${versionId} for job ${jobId}`);
    return true;
  }

  async upsertJob(job: JobRecord, sourceDir?: string): Promise<JobRecord> {
    const destination = this.getJobDir(job.id);
    await fs.mkdir(destination, { recursive: true });
    if (sourceDir) {
      await fs.cp(sourceDir, destination, { recursive: true });
    }
    await this.jobDatabase.ensureDatabase(destination);
    this.jobs.set(job.id, job);
    await this.persistJobRecord(job);
    await this.saveJobs();
    return job;
  }
}

function jobVersionIdToTimestamp(versionId: string): string {
  const firstUnderscore = versionId.indexOf("_");
  const raw = firstUnderscore >= 0 ? versionId.slice(0, firstUnderscore) : versionId;
  return raw.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z");
}

export function getJobsService(): JobsService {
  if (!jobsServiceInstance) {
    jobsServiceInstance = new JobsService();
  }
  return jobsServiceInstance;
}

/** Reset singleton between unit tests (avoids stale HOME paths). */
export function resetJobsServiceSingletonForTests(): void {
  jobsServiceInstance = null;
}

export async function initializeJobsService(): Promise<JobsService> {
  const service = getJobsService();
  await service.initialize();
  return service;
}
