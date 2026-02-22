import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { ChildProcessWithoutNullStreams } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { JobDatabase } from "./jobs/JobDatabase.js";
import { CommandJobExecutor } from "./jobs/executors/CommandJobExecutor.js";
import { AgentJobExecutor } from "./jobs/executors/AgentJobExecutor.js";
import type { IJobExecutor } from "./jobs/executors/IJobExecutor.js";
import { sanitizeError } from "../../core/tools/security.js";
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
    this.paprRootDir = path.join(homeDir, "PAPR");
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

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.migrateLegacyIfNeeded();
    await fs.mkdir(this.jobsRootDir, { recursive: true });
    await fs.mkdir(path.dirname(this.jobsIndexPath), { recursive: true });
    await this.loadJobs();

    // Reconcile interrupted jobs from previous session
    await this.reconcileInterruptedJobs();

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
   * Rebuilds ~/PAPR/data/job-graph.json from current jobs + app data-sources.
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
          edges.push({ from: dep.jobId, to: job.id, onStatus: dep.onStatus });
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
          try {
            const dataSources = await appService.listAppDataSources(app.id);
            const jobIds = [...new Set(dataSources.map((ds) => ds.jobId))];
            if (jobIds.length > 0) {
              appLinks[app.id] = { name: app.title, jobIds };
            }
          } catch {
            // skip apps with no data sources
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
    return job;
  }

  private async appendLog(jobId: string, line: string): Promise<void> {
    const logPath = this.getJobLogPath(jobId);
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    await fs.appendFile(logPath, stamped, "utf8");

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

    return next;
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
    const now = Date.now();
    if (schedule.intervalMs && schedule.intervalMs > 0) {
      return {
        ...previous,
        nextRunAt: new Date(now + schedule.intervalMs).toISOString(),
      };
    }
    if (schedule.atTime) {
      const at = new Date(schedule.atTime).getTime();
      if (!Number.isNaN(at) && at > now) {
        return {
          ...previous,
          nextRunAt: new Date(at).toISOString(),
        };
      }
    }
    if (schedule.cron) {
      // Next run is calculated by scheduler for cron schedules.
      return {
        ...previous,
      };
    }
    return previous;
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
        resolve({ exitCode, lastOutput });
      });
      proc.on("error", (error: Error) => {
        this.running.delete(job.id);
        void appendRunLog(`Process error: ${error.message}`);
        resolve({ exitCode: -1, errorMessage: error.message });
      });
    });
  }

  private async runJobWithDependencies(
    jobId: string,
    stack: Set<string>,
    runtimeParams?: Record<string, string>,
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
      const maxAttempts = Math.max(1, job.retries?.maxAttempts ?? 1);
      const backoffMs = Math.max(0, job.retries?.backoffMs ?? 1000);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
          // Mark scheduled execution as complete
          if (updated.scheduleState?.currentIdempotencyKey) {
            await this.setJobStatus(job.id, status, {
              scheduleState: {
                ...updated.scheduleState,
                lastIdempotencyKey: updated.scheduleState.currentIdempotencyKey,
                currentIdempotencyKey: undefined,
              },
            });
          }
          return updated;
        }

        // Calculate and store next retry time
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
  ): Promise<JobRecord> {
    return this.runJobWithDependencies(jobId, new Set<string>(), runtimeParams);
  }

  async runJobFromScheduler(
    jobId: string,
    triggeredAt: string,
  ): Promise<JobRecord> {
    const existing = await this.getJob(jobId);
    if (!existing) {
      throw new Error(`Job not found: ${jobId}`);
    }
    if (existing.schedule?.enabled) {
      // Generate idempotency key to prevent duplicate scheduled runs
      const idempotencyKey = `${jobId}-${triggeredAt}`;

      // Check if we already ran this scheduled execution
      if (existing.scheduleState?.currentIdempotencyKey === idempotencyKey) {
        await this.appendLog(
          jobId,
          `Skipping duplicate scheduled run (idempotency key: ${idempotencyKey})`,
        );
        return existing;
      }

      await this.setJobStatus(jobId, existing.status, {
        scheduleState: {
          ...existing.scheduleState,
          lastScheduledRunAt: triggeredAt,
          lastTriggeredAt: triggeredAt,
          currentIdempotencyKey: idempotencyKey,
          nextRunAt: this.computeScheduleState(
            existing.schedule,
            existing.scheduleState,
          )?.nextRunAt,
        },
      });
    }
    return this.runJob(jobId);
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
    this.jobs.set(jobId, updated);
    await this.saveJobs();
    void this.rebuildGraph();

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

  async upsertJob(job: JobRecord, sourceDir?: string): Promise<JobRecord> {
    const destination = this.getJobDir(job.id);
    await fs.mkdir(destination, { recursive: true });
    if (sourceDir) {
      await fs.cp(sourceDir, destination, { recursive: true });
    }
    await this.jobDatabase.ensureDatabase(destination);
    this.jobs.set(job.id, job);
    await this.saveJobs();
    return job;
  }
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
