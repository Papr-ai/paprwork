import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getApiKeysForSanitization, sanitizeError } from "./security.js";

const appFileSchema = z.object({
  filename: z.string().min(1),
  content: z.string(),
});

const createAppSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional().describe(
    "SVG string or emoji for the app logo. Shown in tabs and favorites. " +
    "Use an inline SVG (e.g. '<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" width=\"14\" height=\"14\">...</svg>') " +
    "or a single emoji (e.g. '📊'). Alternatively, add a <link rel=\"icon\" href=\"data:image/svg+xml,...\"> tag " +
    "in your index.html — it will be auto-extracted as the icon."
  ),
  files: z.array(appFileSchema).optional(),
  html: z.string().optional(),
  css: z.string().optional(),
  javascript: z.string().optional(),
});

const dependencySchema = z.object({
  jobId: z.string().min(1),
  onStatus: z.enum(["completed", "failed"]).default("completed"),
});

const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(1),
  backoffMs: z.number().int().min(0).max(120000).default(1000),
});

const deliverySchema = z.object({
  channel: z.literal("chat"),
  targetId: z.string().min(1),
});

const scheduleSchema = z.object({
  enabled: z.boolean().default(true),
  cron: z.string().min(1).optional(),
  intervalMs: z.number().int().min(1000).optional(),
  atTime: z.string().min(1).optional(),
  catchUpMissed: z.boolean().optional(),
});

const createJobSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["shell", "bash", "node", "python", "swift", "agent", "subagent"]),
  folder: z.string().optional().describe(
    "Folder label to group related jobs (e.g. 'ingestion', 'processing', 'reporting'). " +
    "Use list_job_folders first to see existing groups. Same name = same folder.",
  ),
  command: z.string().optional(),
  requirements: z.array(z.string().min(1)).optional().describe(
    "Python/Node packages to install before running. Creates a venv automatically. Example: ['anthropic', 'requests', 'sqlite-utils']"
  ),
  dependsOn: z.array(dependencySchema).optional(),
  retries: retrySchema.optional(),
  deliver: deliverySchema.optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  schedule: scheduleSchema.optional(),
  subAgentId: z.string().min(1).optional(),
  delegatedBy: z.string().min(1).optional(),
  delegationTask: z.string().min(1).optional(),
  delegationContext: z.string().optional(),
  outputMode: z.enum(["natural", "structured"]).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  memoryPolicy: z.enum(["none", "summary", "full"]).optional(),
  reportChatId: z.string().min(1).optional(),
});

const runJobSchema = z.object({
  jobId: z.string().min(1),
  logBytes: z.number().int().min(200).max(200000).optional(),
});

const linkAppDataSourceSchema = z.object({
  appId: z.string().min(1),
  jobId: z.string().min(1),
  alias: z.string().min(1).optional(),
  tables: z.array(z.string().min(1)).optional(),
  dbPath: z.string().min(1).optional(),
});

const readAppDataSourcesSchema = z.object({
  appId: z.string().min(1),
});

const readJobLogsSchema = z.object({
  jobId: z.string().min(1),
  maxBytes: z.number().int().min(500).max(200000).optional(),
});

type CreateAppArgs = z.infer<typeof createAppSchema>;
type CreateJobArgs = z.infer<typeof createJobSchema>;
type RunJobArgs = z.infer<typeof runJobSchema>;
type LinkAppDataSourceArgs = z.infer<typeof linkAppDataSourceSchema>;
type ReadAppDataSourcesArgs = z.infer<typeof readAppDataSourcesSchema>;
type ReadJobLogsArgs = z.infer<typeof readJobLogsSchema>;

let liquidGlassBaseCache: string | null = null;

async function loadLiquidGlassBase(): Promise<string> {
  if (liquidGlassBaseCache) return liquidGlassBaseCache;

  const { promises: fsP } = await import("fs");
  const pathMod = await import("path");
  const { fileURLToPath } = await import("url");

  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = pathMod.default.dirname(thisFile);

  const candidates = [
    pathMod.default.resolve(thisDir, "../../resources/app-templates/liquid-glass-base.css"),
    pathMod.default.resolve(thisDir, "../../../src/resources/app-templates/liquid-glass-base.css"),
    pathMod.default.resolve(process.cwd(), "src/resources/app-templates/liquid-glass-base.css"),
  ];

  for (const candidate of candidates) {
    try {
      const content = await fsP.readFile(candidate, "utf8");
      liquidGlassBaseCache = content;
      return content;
    } catch {
      // try next
    }
  }

  // Fallback: minimal tokens if template not found
  return `/* Liquid Glass Base (minimal fallback) */
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", system-ui, sans-serif;
  --text-md: 15px; --space-4: 16px; --space-6: 24px;
  --r-md: 14px; --r-lg: 18px; --accent: #0161E0;
  --bg: #ffffff; --text: #14161a; --muted: #667085;
  --glass: rgba(255,255,255,0.65); --glass-border: rgba(15,23,42,0.12);
  --shadow-1: 0 1px 2px rgba(0,0,0,0.06);
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #05070b; --text: rgba(255,255,255,0.92); --muted: rgba(255,255,255,0.55);
    --glass: rgba(14,18,28,0.55); --glass-border: rgba(255,255,255,0.12); }
}
body { font-family: var(--font-sans); font-size: var(--text-md); color: var(--text); background: var(--bg); padding: var(--space-6); }
`;
}

function resolveAppFiles(args: CreateAppArgs): Array<{ filename: string; content: string }> {
  if (args.files && args.files.length > 0) {
    return args.files;
  }

  const html = args.html ?? '<!doctype html>\n<html>\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="app.ts"></script>\n</body>\n</html>';
  const css = args.css ?? null; // Will be resolved async in the tool execute
  const javascript = args.javascript ?? "const app = document.getElementById('app');\nif (app) {\n  app.textContent = 'App initialized';\n}\n";

  const files = [
    { filename: "index.html", content: html },
    { filename: "app.ts", content: javascript },
  ];

  if (css !== null) {
    files.push({ filename: "style.css", content: css });
  }

  return files;
}

export const createAppTool = createTool({
  id: "create_app",
  description: "Create a mini-app artifact with one or more files. Uses TypeScript (.ts) and Liquid Glass design system by default.",
  inputSchema: createAppSchema,
  execute: async (input) => {
    const args = (input as { context?: CreateAppArgs }).context ?? input;
    const { getAppService } = await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();

    const files = resolveAppFiles(args);

    // Auto-inject Liquid Glass base CSS if no style.css was provided
    const hasStylesheet = files.some(f => f.filename === "style.css");
    if (!hasStylesheet) {
      const baseCss = await loadLiquidGlassBase();
      files.push({ filename: "style.css", content: baseCss });
    }

    const app = await appService.createApp(
      args.title,
      args.description ?? "Created by agent",
      files,
      args.icon,
    );
    return { success: true, data: app };
  },
});

export const createJobTool = createTool({
  id: "create_job",
  description: "Create a job with optional DAG dependencies, retries, and delivery",
  inputSchema: createJobSchema,
  execute: async (input) => {
    const args = (input as { context?: CreateJobArgs }).context ?? input;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const job = await jobsService.createJob({
      name: args.name,
      type: args.type,
      folder: args.folder,
      command: args.command,
      requirements: args.requirements,
      dependsOn: args.dependsOn?.map((dependency) => ({
        jobId: dependency.jobId,
        onStatus: dependency.onStatus ?? "completed",
      })),
      retries: args.retries
        ? {
            maxAttempts: args.retries.maxAttempts ?? 1,
            backoffMs: args.retries.backoffMs ?? 1000,
          }
        : undefined,
      deliver: args.deliver,
      retentionDays: args.retentionDays,
      schedule: args.schedule
        ? {
            enabled: args.schedule.enabled ?? true,
            cron: args.schedule.cron,
            intervalMs: args.schedule.intervalMs,
            atTime: args.schedule.atTime,
            catchUpMissed: args.schedule.catchUpMissed,
          }
        : undefined,
      subAgentId: args.subAgentId,
      delegatedBy: args.delegatedBy,
      delegationTask: args.delegationTask,
      delegationContext: args.delegationContext,
      outputMode: args.outputMode,
      outputSchema: args.outputSchema,
      maxTurns: args.maxTurns,
      memoryPolicy: args.memoryPolicy,
      reportChatId: args.reportChatId,
    });
    return { success: true, data: job };
  },
});

export const runJobTool = createTool({
  id: "run_job",
  description: "Run a job by id and return status/logs/database info",
  inputSchema: runJobSchema,
  execute: async (input) => {
    const args = (input as { context?: RunJobArgs }).context ?? input;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const job = await jobsService.runJob(args.jobId);
    const apiKeys = getApiKeysForSanitization();
    const logs = sanitizeError(
      await jobsService.getLogs(args.jobId, args.logBytes ?? 12000),
      apiKeys,
    );
    const dbPath = await jobsService.getJobDatabasePath(args.jobId);
    return {
      success: true,
      data: {
        job,
        logs,
        dbPath,
      },
    };
  },
});

export const readJobLogsTool = createTool({
  id: "read_job_logs",
  description: "Read job logs for debugging and validation",
  inputSchema: readJobLogsSchema,
  execute: async (input) => {
    const args = (input as { context?: ReadJobLogsArgs }).context ?? input;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const job = await jobsService.getJob(args.jobId);
    if (!job) {
      throw new Error(`Job not found: ${args.jobId}`);
    }
    const apiKeys = getApiKeysForSanitization();
    const logs = sanitizeError(
      await jobsService.getLogs(args.jobId, args.maxBytes ?? 20000),
      apiKeys,
    );
    return {
      success: true,
      data: {
        job,
        logs,
      },
    };
  },
});

export const linkAppDataSourceTool = createTool({
  id: "link_app_data_source",
  description: "Link a mini-app to a job SQLite database data source",
  inputSchema: linkAppDataSourceSchema,
  execute: async (input) => {
    const args =
      (input as { context?: LinkAppDataSourceArgs }).context ?? input;
    const { getAppService } = await import("../../gateway/services/AppService.js");
    const { getJobsService } = await import(
      "../../gateway/services/JobsService.js"
    );
    const appService = getAppService();
    const jobsService = getJobsService();
    await appService.initialize();
    await jobsService.initialize();

    const app = await appService.getApp(args.appId);
    if (!app) {
      throw new Error(`App not found: ${args.appId}`);
    }
    const job = await jobsService.getJob(args.jobId);
    if (!job) {
      throw new Error(`Job not found: ${args.jobId}`);
    }
    const dbPath =
      args.dbPath ?? (await jobsService.getJobDatabasePath(args.jobId));
    if (!dbPath) {
      throw new Error(`Database path not found for job: ${args.jobId}`);
    }

    const alias = args.alias ?? `${job.name} (${job.id.slice(0, 8)})`;
    const tables = args.tables ?? [];
    const dataSources = await appService.linkAppDataSource(args.appId, {
      id: `${args.jobId}:${alias}`,
      type: "sqlite",
      jobId: args.jobId,
      alias,
      dbPath,
      tables,
    });
    return {
      success: true,
      data: {
        appId: args.appId,
        jobId: args.jobId,
        dataSources,
      },
    };
  },
});

export const readAppDataSourcesTool = createTool({
  id: "read_app_data_sources",
  description: "List app data-source bindings for job/database wiring",
  inputSchema: readAppDataSourcesSchema,
  execute: async (input) => {
    const args =
      (input as { context?: ReadAppDataSourcesArgs }).context ?? input;
    const { getAppService } = await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();
    const app = await appService.getApp(args.appId);
    if (!app) {
      throw new Error(`App not found: ${args.appId}`);
    }
    const dataSources = await appService.listAppDataSources(args.appId);
    return {
      success: true,
      data: {
        appId: args.appId,
        dataSources,
      },
    };
  },
});

// ===== App file editing tools =====

const readAppFileSchema = z.object({
  appId: z.string().min(1).describe("App UUID"),
  filename: z.string().min(1).describe("Filename to read (e.g. index.html, style.css, app.js)"),
});

const editAppFileSchema = z.object({
  appId: z.string().min(1).describe("App UUID"),
  filename: z.string().min(1).describe("Filename to edit"),
  oldString: z.string().min(1).describe("Exact string to find in the file"),
  newString: z.string().describe("Replacement string (use empty string to delete)"),
});

const listAppFilesSchema = z.object({
  appId: z.string().min(1).describe("App UUID"),
});

const listAppsSchema = z.object({
  includeCompleted: z.boolean().optional().describe("Include completed/archived apps (default: false)"),
});

const updateJobSchema = z.object({
  jobId: z.string().min(1).describe("ID of the job to update (get it from list_jobs)"),
  name: z.string().min(1).optional().describe("New display name for the job"),
  folder: z.string().optional().describe("Assign or change the job's folder group (e.g. 'ingestion'). Use set_job_folder for a dedicated tool."),
  command: z.string().optional().describe("New command to run (e.g. 'python3 selector.py')"),
  requirements: z.array(z.string().min(1)).optional().describe(
    "Updated Python/Node packages. Rewrites requirements.txt immediately. Pass [] to clear.",
  ),
  dependsOn: z.array(dependencySchema).optional().describe("Replace the full dependency list"),
  retries: retrySchema.optional().describe("Update retry policy"),
  retentionDays: z.number().int().min(1).max(365).optional().describe("How many days to keep job data"),
  schedule: scheduleSchema.optional().describe("Update or set a schedule"),
  outputMode: z.enum(["natural", "structured"]).optional().describe("Change output mode"),
  outputSchema: z.record(z.string(), z.unknown()).optional().describe("Update structured output schema"),
  maxTurns: z.number().int().min(1).max(100).optional().describe("Update max turns for agent jobs"),
  memoryPolicy: z.enum(["none", "summary", "full"]).optional().describe("Update memory policy for agent jobs"),
  reportChatId: z.string().min(1).optional().describe("Update which chat receives job results"),
});

const deleteJobSchema = z.object({
  jobId: z.string().min(1).describe("ID of the job to delete"),
  deleteFiles: z.boolean().optional().describe(
    "Also delete the job's directory (scripts, logs, database). Default: false — keeps files on disk but removes the job from the index.",
  ),
});

const listJobsSchema = z.object({
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]).optional()
    .describe("Filter by status. Omit to return all jobs."),
  type: z.enum(["shell", "bash", "node", "python", "swift", "agent", "subagent"]).optional()
    .describe("Filter by runtime type."),
  folder: z.string().optional()
    .describe("Filter to jobs in this folder (e.g. 'ingestion'). Use list_job_folders to see available folders."),
  appId: z.string().optional()
    .describe("Filter to jobs linked to this app ID via data-sources."),
  limit: z.number().int().min(1).max(200).optional()
    .describe("Max jobs to return (default: 50, newest first)."),
});

const listJobFilesSchema = z.object({
  jobId: z.string().min(1).describe("Job UUID"),
});

const readJobFileSchema = z.object({
  jobId: z.string().min(1).describe("Job UUID"),
  filename: z.string().min(1).describe("Filename relative to the job directory (e.g. selector.py, requirements.txt)"),
});

const editJobFileSchema = z.object({
  jobId: z.string().min(1).describe("Job UUID"),
  filename: z.string().min(1).describe("Filename to edit (relative to job directory)"),
  oldString: z.string().min(1).describe("Exact string to find and replace. Must match character-for-character including whitespace."),
  newString: z.string().describe("Replacement string. Use empty string to delete the matched section."),
});

type ReadAppFileArgs = z.infer<typeof readAppFileSchema>;
type EditAppFileArgs = z.infer<typeof editAppFileSchema>;
type ListAppFilesArgs = z.infer<typeof listAppFilesSchema>;

export const readAppFileTool = createTool({
  id: "read_app_file",
  description: "Read a specific file from a mini-app by filename",
  inputSchema: readAppFileSchema,
  execute: async (input) => {
    const args = (input as { context?: ReadAppFileArgs }).context ?? input;
    const { getAppService } = await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();
    const content = await appService.readAppFile(args.appId, args.filename);
    if (content === null) {
      throw new Error(`File not found: ${args.filename} in app ${args.appId}`);
    }
    return { success: true, data: { filename: args.filename, content } };
  },
});

export const editAppFileTool = createTool({
  id: "edit_app_file",
  description: "Edit a mini-app file by replacing an exact string occurrence with a new string",
  inputSchema: editAppFileSchema,
  execute: async (input) => {
    const args = (input as { context?: EditAppFileArgs }).context ?? input;
    const { getAppService } = await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();

    const content = await appService.readAppFile(args.appId, args.filename);
    if (content === null) {
      throw new Error(`File not found: ${args.filename} in app ${args.appId}`);
    }

    if (!content.includes(args.oldString)) {
      throw new Error(
        `String not found in ${args.filename}. Make sure oldString matches exactly.`,
      );
    }

    const newContent = content.replace(args.oldString, args.newString);
    await appService.writeAppFile(args.appId, args.filename, newContent);
    return { success: true, data: { filename: args.filename, updated: true } };
  },
});

export const listAppFilesTool = createTool({
  id: "list_app_files",
  description: "List all files in a mini-app",
  inputSchema: listAppFilesSchema,
  execute: async (input) => {
    const args = (input as { context?: ListAppFilesArgs }).context ?? input;
    const { getAppService } = await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();
    const app = await appService.getApp(args.appId);
    if (!app) {
      throw new Error(`App not found: ${args.appId}`);
    }
    // Read app directory to list files
    const { promises: fsPromises } = await import("fs");
    const pathModule = await import("path");
    const osModule = await import("os");
    const appDir = pathModule.default.join(
      osModule.default.homedir(),
      "PAPR",
      "apps",
      args.appId,
    );
    const entries = await fsPromises.readdir(appDir);
    const files = entries.filter(
      (e) => !e.startsWith(".") && e !== "data-sources.json",
    );
    return { success: true, data: { appId: args.appId, files } };
  },
});

export const listAppsTool = createTool({
  id: "list_apps",
  description:
    "List all mini-apps. **ALWAYS call this BEFORE creating a new app** to check if a similar app already exists that you can update instead.",
  inputSchema: listAppsSchema,
  execute: async () => {
    const { getAppService } = await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();
    const apps = await appService.listApps();

    const appsData = apps.map((app) => ({
      id: app.id,
      title: app.title,
      description: app.description,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      favorite: app.favorite,
    }));

    return {
      success: true,
      data: {
        apps: appsData,
        count: appsData.length,
      },
    };
  },
});

type UpdateJobArgs = z.infer<typeof updateJobSchema>;
type DeleteJobArgs = z.infer<typeof deleteJobSchema>;
type ListJobsArgs = z.infer<typeof listJobsSchema>;
type ListJobFilesArgs = z.infer<typeof listJobFilesSchema>;
type ReadJobFileArgs = z.infer<typeof readJobFileSchema>;
type EditJobFileArgs = z.infer<typeof editJobFileSchema>;

export const updateJobTool = createTool({
  id: "update_job",
  description: `Update an existing job's configuration. Only the fields you provide are changed — everything else stays the same.
Cannot update a currently running job (stop it first with bash or wait for it to finish).
Common use cases:
- Fix a buggy command: { jobId, command: "python3 fixed_script.py" }
- Add missing requirements: { jobId, requirements: ["anthropic", "requests"] }
- Change a dependency: { jobId, dependsOn: [{ jobId: "...", onStatus: "completed" }] }
- Enable/change a schedule: { jobId, schedule: { enabled: true, cron: "0 9 * * *" } }
- Adjust retries after a flaky run: { jobId, retries: { maxAttempts: 3, backoffMs: 5000 } }`,
  inputSchema: updateJobSchema,
  execute: async (input) => {
    const args = (input as { context?: UpdateJobArgs }).context ?? input;
    const { jobId, dependsOn, retries, schedule, folder, ...rest } = args;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const job = await jobsService.updateJob(jobId, {
      ...rest,
      ...(folder !== undefined ? { folder } : {}),
      ...(dependsOn !== undefined
        ? {
            dependsOn: dependsOn.map((d) => ({
              jobId: d.jobId,
              onStatus: d.onStatus ?? "completed",
            })),
          }
        : {}),
      ...(retries !== undefined
        ? {
            retries: {
              maxAttempts: retries.maxAttempts ?? 1,
              backoffMs: retries.backoffMs ?? 1000,
            },
          }
        : {}),
      ...(schedule !== undefined
        ? {
            schedule: {
              enabled: schedule.enabled ?? true,
              cron: schedule.cron,
              intervalMs: schedule.intervalMs,
              atTime: schedule.atTime,
              catchUpMissed: schedule.catchUpMissed,
            },
          }
        : {}),
    });
    return { success: true, data: job };
  },
});

export const deleteJobTool = createTool({
  id: "delete_job",
  description: `Delete a job by id. Stops it first if currently running.
By default, keeps the job's files on disk (scripts, logs, database) but removes it from the job index.
Set deleteFiles: true to also wipe the directory — use this for jobs created by mistake with no useful data.
Does NOT affect other jobs that depend on this job; update or recreate those separately.`,
  inputSchema: deleteJobSchema,
  execute: async (input) => {
    const args = (input as { context?: DeleteJobArgs }).context ?? input;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const result = await jobsService.deleteJob(args.jobId, args.deleteFiles ?? false);
    return {
      success: true,
      data: {
        deleted: result,
        filesRemoved: args.deleteFiles ?? false,
      },
    };
  },
});

// ===== Job file editing tools =====

async function getJobDir(jobId: string): Promise<string> {
  const osModule = await import("os");
  const pathModule = await import("path");
  return pathModule.default.join(osModule.default.homedir(), "PAPR", "jobs", jobId);
}

export const listJobFilesTool = createTool({
  id: "list_job_files",
  description: "List all files in a job's directory — scripts, logs, requirements.txt, etc. Use this before read_job_file or edit_job_file to confirm filenames.",
  inputSchema: listJobFilesSchema,
  execute: async (input) => {
    const args = (input as { context?: ListJobFilesArgs }).context ?? input;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    const job = await jobsService.getJob(args.jobId);
    if (!job) {
      throw new Error(`Job not found: ${args.jobId}`);
    }

    const { promises: fsPromises } = await import("fs");
    const pathModule = await import("path");
    const jobDir = await getJobDir(args.jobId);

    console.log(`[list_job_files] Scanning job directory: ${jobDir}`);

    const walk = async (dir: string, base: string): Promise<string[]> => {
      let entries: string[] = [];
      try {
        const items = await fsPromises.readdir(dir, { withFileTypes: true });
        for (const item of items) {
          const rel = base ? `${base}/${item.name}` : item.name;
          if (item.isDirectory()) {
            const sub = await walk(pathModule.default.join(dir, item.name), rel);
            entries = entries.concat(sub);
          } else {
            entries.push(rel);
          }
        }
      } catch (err) {
        console.warn(`[list_job_files] Could not read dir ${dir}:`, err);
      }
      return entries;
    };

    const files = await walk(jobDir, "");
    console.log(`[list_job_files] Found ${files.length} file(s) for job ${args.jobId}`);

    return {
      success: true,
      data: {
        jobId: args.jobId,
        name: job.name,
        dir: jobDir,
        files,
        tip: "Use read_job_file({ jobId, filename }) to view a file, edit_job_file to patch it, or read_job_logs to see the last run output.",
      },
    };
  },
});

export const readJobFileTool = createTool({
  id: "read_job_file",
  description: "Read a source file from a job's directory (e.g. the Python/Node script). Use list_job_files first to confirm the filename.",
  inputSchema: readJobFileSchema,
  execute: async (input) => {
    const args = (input as { context?: ReadJobFileArgs }).context ?? input;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    const job = await jobsService.getJob(args.jobId);
    if (!job) {
      throw new Error(`Job not found: ${args.jobId}`);
    }

    const { promises: fsPromises } = await import("fs");
    const pathModule = await import("path");
    const jobDir = await getJobDir(args.jobId);
    const filePath = pathModule.default.join(jobDir, args.filename);

    // Safety: ensure the resolved path stays inside the job directory
    const resolvedPath = pathModule.default.resolve(filePath);
    const resolvedDir = pathModule.default.resolve(jobDir);
    if (!resolvedPath.startsWith(resolvedDir + pathModule.default.sep) && resolvedPath !== resolvedDir) {
      throw new Error(`Path traversal rejected: ${args.filename}`);
    }

    console.log(`[read_job_file] Reading ${resolvedPath}`);

    let content: string;
    try {
      content = await fsPromises.readFile(resolvedPath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new Error(`File not found: ${args.filename} in job ${args.jobId}. Call list_job_files to see what exists.`);
      }
      throw err;
    }

    console.log(`[read_job_file] Read ${content.length} chars from ${args.filename}`);
    return {
      success: true,
      data: {
        jobId: args.jobId,
        filename: args.filename,
        path: resolvedPath,
        content,
        lines: content.split("\n").length,
      },
    };
  },
});

export const editJobFileTool = createTool({
  id: "edit_job_file",
  description: `Edit a job's source file by replacing an exact string with a new string — same pattern as edit_app_file.
Always read_job_file first to get the exact current content before editing.
Use this to fix bugs in scripts, update SQL queries, change API endpoints, add logging, etc.
After editing, run_job to test the changes, then read_job_logs to verify.`,
  inputSchema: editJobFileSchema,
  execute: async (input) => {
    const args = (input as { context?: EditJobFileArgs }).context ?? input;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    const job = await jobsService.getJob(args.jobId);
    if (!job) {
      throw new Error(`Job not found: ${args.jobId}`);
    }
    if (job.status === "running") {
      throw new Error(`Job ${args.jobId} is currently running. Wait for it to finish before editing its files.`);
    }

    const { promises: fsPromises } = await import("fs");
    const pathModule = await import("path");
    const jobDir = await getJobDir(args.jobId);
    const filePath = pathModule.default.join(jobDir, args.filename);

    // Safety: path traversal guard
    const resolvedPath = pathModule.default.resolve(filePath);
    const resolvedDir = pathModule.default.resolve(jobDir);
    if (!resolvedPath.startsWith(resolvedDir + pathModule.default.sep) && resolvedPath !== resolvedDir) {
      throw new Error(`Path traversal rejected: ${args.filename}`);
    }

    console.log(`[edit_job_file] Editing ${resolvedPath}`);

    let content: string;
    try {
      content = await fsPromises.readFile(resolvedPath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new Error(`File not found: ${args.filename} in job ${args.jobId}. Call list_job_files to see what exists.`);
      }
      throw err;
    }

    if (!content.includes(args.oldString)) {
      console.error(`[edit_job_file] oldString not found in ${args.filename}. File length: ${content.length} chars.`);
      throw new Error(
        `String not found in ${args.filename}. The oldString must match exactly including whitespace and indentation. ` +
        `Use read_job_file to get the current content first.`,
      );
    }

    const occurrences = content.split(args.oldString).length - 1;
    if (occurrences > 1) {
      console.warn(`[edit_job_file] oldString appears ${occurrences} times in ${args.filename} — replacing first occurrence only`);
    }

    const newContent = content.replace(args.oldString, args.newString);
    await fsPromises.writeFile(resolvedPath, newContent, "utf8");

    console.log(`[edit_job_file] Successfully patched ${args.filename} (${occurrences} occurrence replaced)`);

    return {
      success: true,
      data: {
        jobId: args.jobId,
        filename: args.filename,
        path: resolvedPath,
        occurrencesReplaced: occurrences > 1 ? 1 : occurrences,
        linesAfter: newContent.split("\n").length,
        tip: "Run run_job({ jobId }) to test, then read_job_logs({ jobId }) to verify the output.",
      },
    };
  },
});

export const listJobsTool = createTool({
  id: "list_jobs",
  description: `List all jobs with their status, type, dependencies, schedule, and directory path.
Use this to:
- See what jobs exist before creating a new one (avoid duplicates)
- Find a jobId to pass to run_job or read_job_logs
- Understand the dependency graph of a pipeline
- Check which jobs are running, failed, or completed
Returns jobs sorted newest-first. Filter by status or type as needed.`,
  inputSchema: listJobsSchema,
  execute: async (input) => {
    const args = (input as { context?: ListJobsArgs }).context ?? input;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    let jobs = await jobsService.listJobs(
      args.folder ?? args.appId
        ? { folder: args.folder, appId: args.appId }
        : undefined,
    );

    if (args.status) {
      jobs = jobs.filter((j) => j.status === args.status);
    }
    if (args.type) {
      jobs = jobs.filter((j) => j.type === args.type);
    }

    const limit = args.limit ?? 50;
    jobs = jobs.slice(0, limit);

    const osModule = await import("os");
    const pathModule = await import("path");
    const jobsRoot = pathModule.default.join(osModule.default.homedir(), "PAPR", "jobs");

    const jobsSummary = jobs.map((j) => ({
      id: j.id,
      name: j.name,
      type: j.type,
      status: j.status,
      folder: j.folder,
      command: j.command,
      requirements: j.requirements?.length ? j.requirements : undefined,
      dependsOn: j.dependsOn?.length
        ? j.dependsOn.map((d) => ({ jobId: d.jobId, onStatus: d.onStatus }))
        : undefined,
      schedule: j.schedule?.enabled
        ? {
            cron: j.schedule.cron,
            intervalMs: j.schedule.intervalMs,
            atTime: j.schedule.atTime,
          }
        : undefined,
      retries: j.retries?.maxAttempts && j.retries.maxAttempts > 1
        ? j.retries
        : undefined,
      dir: pathModule.default.join(jobsRoot, j.id),
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      lastRunAt: j.lastRunAt,
      completedAt: j.completedAt,
      error: j.error,
    }));

    return {
      success: true,
      data: {
        total: jobsSummary.length,
        jobs: jobsSummary,
        tip: "Use run_job({ jobId }) to run a job, read_job_logs({ jobId }) to inspect output, or bash({ command: 'sqlite3 <dir>/data/data.db .tables' }) to explore its database.",
      },
    };
  },
});

export const appJobsTools = [
  createAppTool,
  createJobTool,
  runJobTool,
  readJobLogsTool,
  listJobsTool,
  listJobFilesTool,
  readJobFileTool,
  editJobFileTool,
  updateJobTool,
  deleteJobTool,
  linkAppDataSourceTool,
  readAppDataSourcesTool,
  readAppFileTool,
  editAppFileTool,
  listAppFilesTool,
  listAppsTool,
];
