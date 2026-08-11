import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { ChildProcess } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
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
import { getJobRunHistory } from "./jobs/JobRunHistory.js";
import {
  getPaprAppsRoot,
  getPaprDataDir,
  getPaprJobsRoot,
} from "../../core/utils/paprRoot.js";
import {
  resolveJobWriteTargets,
  validateWriteDbIdsExist,
} from "./jobAppDatabase.js";
import {
  type AppDataContract,
  validateJobAgainstAppDatabase,
} from "./jobs/jobDatabaseArchitectureValidation.js";

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
export type {
  CreateJobInput,
  JobDelivery,
  JobDependency,
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

export class JobsService {
  private legacyJobsRootDir: string;
  private legacyJobsIndexPath: string;
  private jobs: Map<string, JobRecord>;
  private running: Map<string, ChildProcess>;
  private jobDatabase: JobDatabase;
  private executors: IJobExecutor[];
  private initialized: boolean;
  private initPromise: Promise<void> | null = null;
  private saveLock: Promise<void> | null = null; // Prevent concurrent saves

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
    return getPaprJobsRoot();
  }

  private get jobsIndexPath(): string {
    return path.join(getPaprDataDir(), "jobs.json");
  }

  private get graphPath(): string {
    return path.join(getPaprDataDir(), "job-graph.json");
  }

  /** Reload index from disk after PAPR_HOME changes (cloud agent gateway). */
  async resetForWorkspaceReload(): Promise<void> {
    this.initialized = false;
    this.jobs.clear();
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
      // Path to bundled default jobs (in dist after build)
      // __dirname is dist/gateway/services/ so we need to go up 2 levels to reach dist/
      const defaultJobsDir = path.join(__dirname, "..", "..", "resources", "default-jobs");
      
      // Check if default jobs directory exists
      try {
        await fs.access(defaultJobsDir);
      } catch {
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

  /** Known bundled jobs shipped with Paprwork (Home dashboard). */
  private static readonly BUNDLED_DEFAULT_JOB_IDS = [
    "2cafb2e9-696b-42db-98fa-5d605977123c",
  ] as const;

  /**
   * Sync command/appIds from bundled default-jobs/ for prebuilt jobs already on disk.
   * Skips architecture validation — bundle is the source of truth for these jobs.
   */
  private async syncBundledDefaultJobs(): Promise<void> {
    const defaultJobsDir = path.join(
      __dirname,
      "..",
      "..",
      "resources",
      "default-jobs",
    );

    let changed = false;
    for (const jobId of JobsService.BUNDLED_DEFAULT_JOB_IDS) {
      const job = this.jobs.get(jobId);
      if (!job) continue;

      const bundledPath = path.join(defaultJobsDir, jobId, "job.json");
      let bundled: JobRecord;
      try {
        bundled = JSON.parse(await fs.readFile(bundledPath, "utf8")) as JobRecord;
      } catch {
        continue;
      }

      const nextCommand = bundled.command?.trim();
      const nextAppIds = bundled.appIds?.length ? bundled.appIds : job.appIds;
      const commandChanged = Boolean(nextCommand && nextCommand !== job.command);
      const appIdsChanged =
        JSON.stringify(nextAppIds ?? []) !== JSON.stringify(job.appIds ?? []);

      if (!commandChanged && !appIdsChanged) continue;

      const updated: JobRecord = {
        ...job,
        ...(commandChanged && nextCommand ? { command: nextCommand } : {}),
        ...(appIdsChanged ? { appIds: nextAppIds } : {}),
        updatedAt: new Date().toISOString(),
      };

      this.jobs.set(jobId, updated);
      changed = true;

      try {
        const jobDir = this.getJobDir(jobId);
        await fs.writeFile(
          path.join(jobDir, "job.json"),
          JSON.stringify(updated, null, 2),
          "utf8",
        );
        console.log(
          `[JobsService] Synced bundled default job ${jobId} from resources`,
        );
      } catch (err) {
        console.warn(
          `[JobsService] Could not write synced job ${jobId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (changed) {
      await this.saveJobs();
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
    await this.migrateLegacyIfNeeded();
    await fs.mkdir(this.jobsRootDir, { recursive: true });
    await fs.mkdir(path.dirname(this.jobsIndexPath), { recursive: true });
    await this.loadJobs(); // Load existing jobs FIRST
    await this.backfillJobAppIds();
    await this.rebuildIndexIfCorrupted(); // Safety net: recover jobs on disk but missing from index
    await this.pruneStaleJobEntries(); // Remove index entries whose folders were deleted (e.g. bash rm)
    await this.installDefaultJobs(); // Then install defaults (won't overwrite existing)
    await this.syncBundledDefaultJobs(); // Patch prebuilt jobs (Home) from bundle
    await this.backfillJobAppIds();

    // Initialize run history
    const runHistory = getJobRunHistory();
    await runHistory.initialize();

    // Reconcile interrupted jobs from previous session
    await this.reconcileInterruptedJobs();

    // Detect and mark stale running jobs (jobs stuck in "running" for >30s with no tracked process)
    // Using 30s threshold to catch stale agent jobs faster while avoiding false positives
    await this.reconcileStaleRunningJobs(30_000);

    await this.reconcileScheduleStates();

    void this.rebuildGraph();

    this.initialized = true;
  }

  /**
   * Infer appIds for legacy jobs missing the field (data-sources + folder title match).
   * Jobs with no linkage get STANDALONE_APP_ID.
   */
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
        await fs.writeFile(
          path.join(this.getJobDir(jobId), "job.json"),
          JSON.stringify({ ...job, appIds }, null, 2),
          "utf8",
        );
      } catch {
        // job dir may be missing
      }
    }

    if (changed) {
      await this.saveJobs();
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

      // File exists but is corrupted (truncated write, etc.).
      // Back it up so rebuildIndexIfCorrupted() can recover from disk.
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
   * Safety net: detect if jobs.json is missing jobs that exist on disk.
   * Handles corruption from crashes, failed updates, or race conditions.
   * Scans ~/Papr/jobs/ for job directories not in the index and re-adds them.
   */
  private async rebuildIndexIfCorrupted(): Promise<void> {
    try {
      const dirsOnDisk = await fs.readdir(this.jobsRootDir);
      const jobDirsOnDisk: string[] = [];

      for (const dirName of dirsOnDisk) {
        const dirPath = path.join(this.jobsRootDir, dirName);
        try {
          const stat = await fs.stat(dirPath);
          if (!stat.isDirectory()) continue;
          const files = await fs.readdir(dirPath);
          if (files.length === 0) continue;
          jobDirsOnDisk.push(dirName);
        } catch {
          continue;
        }
      }

      const missingJobIds = jobDirsOnDisk.filter(id => !this.jobs.has(id));

      if (missingJobIds.length === 0) return;

      console.warn(
        `[JobsService] INDEX CORRUPTION DETECTED: ${missingJobIds.length} jobs on disk but missing from jobs.json. Rebuilding...`
      );

      try {
        const backupPath = this.jobsIndexPath + `.backup-${Date.now()}`;
        await fs.copyFile(this.jobsIndexPath, backupPath);
        console.log(`[JobsService] Backed up corrupted index to ${backupPath}`);
      } catch {
        // No existing file to back up
      }

      for (const jobId of missingJobIds) {
        const jobDir = path.join(this.jobsRootDir, jobId);

        let jobJsonRecord: Partial<JobRecord> | null = null;
        try {
          const content = await fs.readFile(
            path.join(jobDir, "job.json"),
            "utf-8",
          );
          jobJsonRecord = JSON.parse(content) as Partial<JobRecord>;
        } catch {
          // job.json missing or corrupt — fall back to legacy recovery below
        }

        if (jobJsonRecord?.type === "subagent") {
          // Ephemeral delegate_task runs — not indexed user jobs.
          if (jobJsonRecord.delegatedBy?.trim()) {
            console.log(
              `[JobsService] Skipping delegated subagent entry: ${jobId}`,
            );
            continue;
          }
          // Persistent subagent jobs (app agent chat) must stay in jobs.json for cloud web.
          if (
            jobJsonRecord.id &&
            jobJsonRecord.name &&
            Array.isArray(jobJsonRecord.appIds) &&
            jobJsonRecord.appIds.length > 0
          ) {
            const recoveredSubagent: JobRecord = {
              ...(jobJsonRecord as JobRecord),
              id: jobJsonRecord.id,
              name: jobJsonRecord.name,
              type: "subagent",
              status: (jobJsonRecord.status as JobStatus) ?? "idle",
              appIds: jobJsonRecord.appIds,
              createdAt:
                jobJsonRecord.createdAt ?? new Date().toISOString(),
              updatedAt:
                jobJsonRecord.updatedAt ?? new Date().toISOString(),
            };
            this.jobs.set(jobId, recoveredSubagent);
            console.log(
              `[JobsService] Recovered subagent job from job.json: ${jobId} - ${recoveredSubagent.name}`,
            );
            continue;
          }
          console.log(
            `[JobsService] Skipping subagent entry without appIds: ${jobId}`,
          );
          continue;
        }

        let name = jobId;
        let type: JobType = "bash";
        let command = "";
        let createdAt = new Date().toISOString();

        // Try reading job.json first (primary source), then metadata.json (legacy)
        let recoveredFromFile = false;
        let folder: string | undefined;
        for (const filename of ["job.json", "metadata.json"]) {
          if (recoveredFromFile) break;
          try {
            const content = await fs.readFile(path.join(jobDir, filename), "utf-8");
            const data = JSON.parse(content) as Partial<JobRecord>;
            name = data.name || name;
            type = (data.type as JobType) || type;
            command = data.command || command;
            if (data.createdAt) createdAt = data.createdAt;
            if (data.folder) folder = data.folder;
            recoveredFromFile = true;
            console.log(`[JobsService] Recovered job data from ${filename}: ${jobId} → "${name}"`);
          } catch {
            // File doesn't exist or is corrupted, try next
          }
        }

        if (!recoveredFromFile) {
          // No job.json or metadata.json — try to infer type from files on disk
          try {
            const files = await fs.readdir(path.join(jobDir, "code"));
            if (files.some(f => f.endsWith(".py"))) type = "python";
            else if (files.some(f => f.endsWith(".js") || f.endsWith(".ts"))) type = "node";
            else if (files.some(f => f.endsWith(".swift"))) type = "swift";
          } catch {
            // No code directory
          }
        }

        try {
          const stat = await fs.stat(jobDir);
          createdAt = stat.birthtime.toISOString();
        } catch {
          // Use current time
        }

        const recoveredJob: JobRecord = {
          id: jobId,
          name,
          type,
          status: "idle" as JobStatus,
          appIds: [],
          command,
          createdAt,
          updatedAt: new Date().toISOString(),
          ...(folder ? { folder } : {}),
        };

        this.jobs.set(jobId, recoveredJob);
        console.log(`[JobsService] Recovered job from disk: ${jobId} - ${name}`);
      }

      await this.saveJobs();
      console.log(
        `[JobsService] Index rebuilt: recovered ${missingJobIds.length} jobs. Total: ${this.jobs.size}`
      );
    } catch (error) {
      console.error("[JobsService] Failed to rebuild index:", error);
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
    await this.rebuildIndexIfCorrupted();
    await this.pruneStaleJobEntries();
    console.log(`[JobsService] Reloaded ${this.jobs.size} jobs from disk`);
    
    // Request scheduler to reschedule in case job schedules changed
    void import("./JobsScheduler.js")
      .then(({ getJobsScheduler }) => {
        getJobsScheduler().requestReschedule();
      })
      .catch(() => {});
  }

  private async saveJobs(): Promise<void> {
    // Wait for any in-flight save to complete
    if (this.saveLock) {
      await this.saveLock;
    }

    // Create new save promise
    this.saveLock = (async () => {
      try {
        const list = Array.from(this.jobs.values()).sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        const data = JSON.stringify(list, null, 2);
        
        // Use timestamp + random suffix to ensure unique temp file
        const tmpPath = this.jobsIndexPath + `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        
        await fs.writeFile(tmpPath, data, "utf8");
        await fs.rename(tmpPath, this.jobsIndexPath);
      } finally {
        // Clear lock after save completes or fails
        this.saveLock = null;
      }
    })();

    // Wait for this save to complete
    await this.saveLock;
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

    return jobs;
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
      createdAt: now,
      updatedAt: now,
    };

    const jobDir = this.getJobDir(id);
    await fs.mkdir(path.join(jobDir, "code"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "logs"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "migrations"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "data"), { recursive: true });
    await this.jobDatabase.ensureDatabase(jobDir);
    await fs.writeFile(
      path.join(jobDir, "job.json"),
      JSON.stringify(job, null, 2),
    );

    // Write requirements.txt if requirements are specified
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

    const now = new Date().toISOString();
    const job: JobRecord = {
      status: "pending",
      appIds: jobDef.appIds?.length ? jobDef.appIds : [STANDALONE_APP_ID],
      dependsOn: [],
      retries: { maxAttempts: 1, backoffMs: 1000 },
      retentionDays: 14,
      outputMode: "natural",
      memoryPolicy: "none",
      ...jobDef,
      createdAt: jobDef.createdAt || now,
      updatedAt: now,
    };

    const jobDir = this.getJobDir(job.id);
    await fs.mkdir(path.join(jobDir, "code"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "logs"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "migrations"), { recursive: true });
    await fs.mkdir(path.join(jobDir, "data"), { recursive: true });
    await this.jobDatabase.ensureDatabase(jobDir);
    await fs.writeFile(
      path.join(jobDir, "job.json"),
      JSON.stringify(job, null, 2),
    );

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
  ): Promise<JobRecord> {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      throw new Error(`Job not found: ${jobId}`);
    }
    const now = new Date().toISOString();
    const next: JobRecord = {
      ...existing,
      ...updates,
      status,
      updatedAt: now,
      ...(status === "running" ? { lastRunAt: now, error: undefined } : {}),
      ...(status === "completed" ||
      status === "failed" ||
      status === "cancelled"
        ? {
            completedAt: now,
            lastRunAt: existing.lastRunAt ?? now,
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
    if (next.schedule?.enabled) {
      next.scheduleState = this.computeScheduleState(
        next.schedule,
        next.scheduleState,
      );
    }
    this.jobs.set(jobId, next);
    await fs.writeFile(
      path.join(this.getJobDir(jobId), "job.json"),
      JSON.stringify(next, null, 2),
      "utf8",
    );
    await this.saveJobs();

    // Broadcast job status change to all connected WebSocket clients (including mini-apps)
    this.broadcastJobStatus(next);

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
            job_id: job.id,
            job_type: job.type,
            duration_ms: Math.round(performance.now() - attemptStart),
            attempts: attempt,
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
            job_id: job.id,
            job_name:
              job.name.length > 80 ? `${job.name.slice(0, 79)}…` : job.name,
            job_type: job.type,
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
    await fs.writeFile(
      path.join(this.getJobDir(jobId), "job.json"),
      JSON.stringify(updated, null, 2),
      "utf8",
    );
    await this.saveJobs();
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
  ): Promise<{ id: string; name: string }> {
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
    await preserveJobLinkedDatabasesBeforeDelete(jobId);

    // Remove from index
    this.jobs.delete(jobId);
    await this.saveJobs();
    void this.rebuildGraph();

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

        await fs.writeFile(
          path.join(this.getJobDir(jobId), "job.json"),
          JSON.stringify(updated, null, 2),
          "utf8",
        );

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

  /**
   * Stop all running jobs (called on graceful shutdown).
   * Kills processes and marks as cancelled.
   */
  async stopAllJobs(): Promise<void> {
    const running = Array.from(this.running.entries());

    if (running.length === 0) {
      console.log("[JobsService] No running jobs to stop");
      return;
    }

    console.log(`[JobsService] Stopping ${running.length} running job(s)...`);

    for (const [jobId, proc] of running) {
      try {
        console.log(`[JobsService] Stopping job ${jobId}`);
        proc.kill("SIGTERM");
        this.running.delete(jobId);

        await this.setJobStatus(jobId, "cancelled", {
          error: "Job stopped due to app shutdown",
          completedAt: new Date().toISOString(),
          currentExecutionId: undefined,
        });
      } catch (error) {
        console.error(`[JobsService] Failed to stop job ${jobId}:`, error);
      }
    }

    console.log("[JobsService] All running jobs stopped");
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
    await fs.writeFile(
      path.join(destination, "job.json"),
      JSON.stringify(job, null, 2),
      "utf8",
    );
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
