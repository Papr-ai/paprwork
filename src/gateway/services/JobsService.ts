import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { JobDatabase } from "./jobs/JobDatabase.js";
import { CommandJobExecutor } from "./jobs/executors/CommandJobExecutor.js";
import { AgentJobExecutor } from "./jobs/executors/AgentJobExecutor.js";
import type { IJobExecutor } from "./jobs/executors/IJobExecutor.js";
import { sanitizeError } from "../../core/tools/security.js";
import { getGatewayTelemetry } from "./gatewayTelemetry.js";
import { getJobRunHistory } from "./jobs/JobRunHistory.js";

// ESM compatibility: get __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  classifyError,
  getErrorClassificationReason,
} from "./jobs/errorClassifier.js";
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

let jobsServiceInstance: JobsService | null = null;

export class JobsService {
  private paprRootDir: string;
  private jobsRootDir: string;
  private jobsIndexPath: string;
  private graphPath: string;
  private legacyJobsRootDir: string;
  private legacyJobsIndexPath: string;
  private jobs: Map<string, JobRecord>;
  private running: Map<string, ChildProcessWithoutNullStreams>;
  private jobDatabase: JobDatabase;
  private executors: IJobExecutor[];
  private initialized: boolean;

  constructor() {
    const homeDir = os.homedir();
    this.paprRootDir = path.join(homeDir, "Papr");
    this.jobsRootDir = path.join(this.paprRootDir, "jobs");
    this.jobsIndexPath = path.join(this.paprRootDir, "data", "jobs.json");
    this.graphPath = path.join(this.paprRootDir, "data", "job-graph.json");
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

        // Read job ID from job-id.txt
        const jobIdPath = path.join(sourceDir, "job-id.txt");
        let jobId: string;
        try {
          jobId = (await fs.readFile(jobIdPath, "utf-8")).trim();
        } catch {
          console.warn(`[JobsService] Skipping default job ${jobDirName}: no job-id.txt`);
          continue;
        }

        // Check if job already exists (both in registry and on disk)
        if (this.jobs.has(jobId)) {
          console.log(`[JobsService] Default job already in registry: ${jobId}`);
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
          // Copy job files (but not data/ directory if it exists)
          await fs.mkdir(targetDir, { recursive: true });
          const entries = await fs.readdir(sourceDir, { withFileTypes: true });
          for (const entry of entries) {
            const sourcePath = path.join(sourceDir, entry.name);
            const targetPath = path.join(targetDir, entry.name);
            if (entry.isDirectory()) {
              // Skip data directory (will be created with db below)
              if (entry.name === 'data') continue;
              await fs.cp(sourcePath, targetPath, { recursive: true });
            } else {
              await fs.copyFile(sourcePath, targetPath);
            }
          }
          console.log(`[JobsService] Copied default job files: ${jobId} (${jobDirName})`);
        }

        // Read metadata.json to get job details
        const metadataPath = path.join(sourceDir, "metadata.json");
        let metadata: Partial<JobRecord> & { description?: string; isDefault?: boolean };
        try {
          const metadataContent = await fs.readFile(metadataPath, "utf-8");
          metadata = JSON.parse(metadataContent);
        } catch {
          console.warn(`[JobsService] No metadata.json found for default job ${jobId}, using defaults`);
          metadata = {
            id: jobId,
            name: jobDirName,
            type: "agent",
            command: "",
          };
        }

        // Create job entry in registry
        const now = new Date().toISOString();
        const job: JobRecord = {
          id: jobId,
          name: metadata.name || jobDirName,
          type: (metadata.type as JobType) || "agent",
          status: "idle" as JobStatus,
          command: metadata.command || "",
          createdAt: metadata.createdAt || now,
          updatedAt: now,
          ...(metadata.schedule ? { schedule: metadata.schedule } : {}),
          ...(metadata.requirements ? { requirements: metadata.requirements } : {}),
          ...(metadata.provider ? { provider: metadata.provider } : {}),
          ...(metadata.model ? { model: metadata.model } : {}),
        };

        this.jobs.set(jobId, job);
        
        // Initialize SQLite database if init-db.sql exists
        const initDbPath = path.join(sourceDir, "init-db.sql");
        try {
          await fs.access(initDbPath);
          const dataDir = path.join(targetDir, "data");
          await fs.mkdir(dataDir, { recursive: true });
          const dbPath = path.join(dataDir, "data.db");
          
          // Create database and execute init script
          const db = new Database(dbPath);
          const initSql = await fs.readFile(initDbPath, "utf-8");
          db.exec(initSql);
          db.close();
          
          console.log(`[JobsService] Initialized database for job: ${jobId}`);
        } catch {
          // No init-db.sql or error initializing - that's okay
        }
        
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

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.migrateLegacyIfNeeded();
    await fs.mkdir(this.jobsRootDir, { recursive: true });
    await fs.mkdir(path.dirname(this.jobsIndexPath), { recursive: true });
    await this.loadJobs();
    await this.installDefaultJobs(); // Install default jobs on first launch

    // Initialize run history
    const runHistory = getJobRunHistory();
    await runHistory.initialize();

    // Reconcile interrupted jobs from previous session
    await this.reconcileInterruptedJobs();

    // Detect and mark stale running jobs (jobs stuck in "running" for >30s with no tracked process)
    // Using 30s threshold to catch stale agent jobs faster while avoiding false positives
    await this.reconcileStaleRunningJobs(30_000);

    await this.reconcileScheduleStates();

    this.initialized = true;
  }

  private async loadJobs(): Promise<void> {
    try {
      const raw = await fs.readFile(this.jobsIndexPath, "utf8");
      const jobs = JSON.parse(raw) as JobRecord[];
      this.jobs = new Map(jobs.map((job) => [job.id, job]));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        console.error("[JobsService] Failed to load jobs:", error);
      }
      this.jobs = new Map();
    }
  }

  /**
   * Reload jobs from disk, picking up any manual edits to jobs.json.
   * Useful when agent or user manually fixes job status on disk.
   */
  async reloadJobs(): Promise<void> {
    console.log("[JobsService] Reloading jobs from disk...");
    await this.loadJobs();
    console.log(`[JobsService] Reloaded ${this.jobs.size} jobs from disk`);
    
    // Request scheduler to reschedule in case job schedules changed
    void import("./JobsScheduler.js")
      .then(({ getJobsScheduler }) => {
        getJobsScheduler().requestReschedule();
      })
      .catch(() => {});
  }

  private async saveJobs(): Promise<void> {
    const list = Array.from(this.jobs.values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    await fs.writeFile(
      this.jobsIndexPath,
      JSON.stringify(list, null, 2),
      "utf8",
    );
  }

  private getJobDir(jobId: string): string {
    return path.join(this.jobsRootDir, jobId);
  }

  getJobsRootPath(): string {
    return this.jobsRootDir;
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
    let jobs = Array.from(this.jobs.values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    if (filter?.folder) {
      jobs = jobs.filter((j) => j.folder === filter.folder);
    }

    if (filter?.appId) {
      try {
        const { getAppService } = await import("./AppService.js");
        const appService = getAppService();
        await appService.initialize();
        const dataSources = await appService.listAppDataSources(filter.appId);
        const jobIds = new Set(dataSources.map((ds) => ds.jobId));
        jobs = jobs.filter((j) => jobIds.has(j.id));
      } catch {
        jobs = [];
      }
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
          
          // Include jobs explicitly linked via data-sources.json
          try {
            const dataSources = await appService.listAppDataSources(app.id);
            for (const ds of dataSources) {
              linkedJobIds.add(ds.jobId);
            }
          } catch {
            // skip apps with no data sources
          }
          
          // Also auto-link jobs whose folder matches the app title (case-insensitive)
          // This enables app filters and graphs to show all related jobs, even if
          // data sources aren't explicitly linked yet. The agent still needs to call
          // link_app_data_source for the app to actually query job databases.
          const appTitleLower = app.title.toLowerCase();
          for (const job of jobs) {
            if (job.folder && job.folder.toLowerCase() === appTitleLower) {
              linkedJobIds.add(job.id);
            }
          }
          
          if (linkedJobIds.size > 0) {
            appLinks[app.id] = { name: app.title, jobIds: [...linkedJobIds] };
          }
          
          // Trigger auto-discovery of data sources for this app
          // This runs asynchronously and won't block graph rebuild
          void appService.autoDiscoverDataSources(app.id).catch(err => {
            console.warn(`[JobsService] Auto-discovery failed for app ${app.id}:`, err);
          });
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

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    const now = new Date().toISOString();
    const id = uuidv4();
    const job: JobRecord = {
      id,
      name: input.name,
      type: input.type,
      status: "pending",
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
    return job;
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
    await fs.appendFile(logPath, stamped, "utf8");

    // Prune log file if it exceeds 2MB
    await this.pruneJobLog(jobId);

    // Broadcast log line to UI for real-time streaming
    this.broadcastJobLogLine(jobId, line);
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
   */
  private broadcastJobLogLine(jobId: string, line: string): void {
    import("../websocket/index.js")
      .then(({ broadcast }) => {
        broadcast({
          type: "jobs:log-line",
          data: { jobId, line },
        });
      })
      .catch(() => {});
  }

  /**
   * Broadcast job status change to all connected clients.
   * Mini-apps listen for `jobs:status-changed` on their own WebSocket connection
   * to ws://localhost:18789 and refresh data when their job completes — no polling needed.
   */
  private broadcastJobStatus(job: JobRecord): void {
    import("../websocket/index.js")
      .then(({ broadcast }) => {
        broadcast({
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
          },
        });
      })
      .catch((err: unknown) => {
        console.warn("[JobsService] Failed to broadcast job status:", err);
        // Non-fatal — job still ran successfully
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
      await appendRunLog(`Applied migrations: ${appliedMigrations.join(", ")}`);
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

    // Sanitize command before logging (replace API key values with ***)
    const sanitizedCommand = await this.sanitizeCommandForLogging(
      launch.command,
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

      proc.stdout.on("data", async (chunk: Buffer) => {
        const text = chunk.toString("utf8").trimEnd();
        // Sanitize stdout before logging
        const sanitized = await this.sanitizeCommandForLogging(text);
        void appendRunLog(sanitized);
        if (outputSize < MAX_OUTPUT_BYTES) {
          outputChunks.push(sanitized);
          outputSize += sanitized.length;
        }
      });
      proc.stderr.on("data", async (chunk: Buffer) => {
        const text = chunk.toString("utf8").trimEnd();
        // Sanitize stderr before logging
        const sanitized = await this.sanitizeCommandForLogging(text);
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
        void appendRunLog(`Process error: ${error.message}`);
        safeResolve({ exitCode: -1, errorMessage: error.message });
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
          getGatewayTelemetry().trackFireAndForget("paprwork_job_completed", {
            job_id: job.id,
            job_type: job.type,
            duration_ms: Math.round(performance.now() - attemptStart),
            attempts: attempt,
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
          getGatewayTelemetry().trackFireAndForget("paprwork_job_failed", {
            job_id: job.id,
            job_type: job.type,
            error_type: `exit_${result.exitCode}`,
            attempts: maxAttempts,
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
    return this.runJob(jobId, undefined, dueAtIso);
  }

  async updateJob(
    jobId: string,
    updates: Partial<
      Pick<
        import("./jobs/types.js").JobRecord,
        | "name"
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

    const updated: import("./jobs/types.js").JobRecord = {
      ...job,
      ...updates,
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

    // Remove from index
    this.jobs.delete(jobId);
    await this.saveJobs();
    void this.rebuildGraph();

    // Optionally remove the job directory (scripts, logs, db)
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
  private async sanitizeCommandForLogging(command: string): Promise<string> {
    const apiKeys: string[] = [];

    // 1. Collect environment keys (from .env.local)
    const envKeys = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "PAPR_API_KEY",
    ];

    for (const keyName of envKeys) {
      const value = process.env[keyName];
      if (value) {
        apiKeys.push(value);
      }
    }

    // 2. Collect custom keys from CustomKeysStorage
    try {
      const { getCustomKeysService } = await import("./CustomKeysService.js");
      const service = getCustomKeysService();
      const storedKeys = await service.listKeys();

      for (const keyMeta of storedKeys) {
        const value = await service.getKeyByName(keyMeta.name);
        if (value) {
          apiKeys.push(value);
        }
      }
    } catch (error) {
      console.warn(
        "[JobsService] Failed to load custom keys for sanitization:",
        error,
      );
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

export async function initializeJobsService(): Promise<JobsService> {
  const service = getJobsService();
  await service.initialize();
  return service;
}
