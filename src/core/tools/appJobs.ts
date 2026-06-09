import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getApiKeysForSanitization, sanitizeError } from "./security.js";

/** Models often send `fileName`; our schemas use `filename`. Normalize before parse to avoid wasted tool calls. */
function coerceFilenameAliasInToolArgs(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const o = raw as Record<string, unknown>;
  if (o.filename === undefined && typeof o.fileName === "string") {
    return { ...o, filename: o.fileName };
  }
  return raw;
}

function toolSchemaWithFilenameAlias<T extends z.ZodType>(schema: T) {
  return z.preprocess(coerceFilenameAliasInToolArgs, schema);
}

const appFileSchema = toolSchemaWithFilenameAlias(
  z.object({
    filename: z.string().min(1),
    content: z.string(),
  }),
);

const createAppSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  icon: z
    .string()
    .refine(
      (val) => {
        const trimmed = val.trim();
        const startsWithSvg = trimmed.startsWith("<");
        const isEmoji = trimmed.length <= 4 && /[\p{Emoji}]/u.test(trimmed);
        const isDataImage = trimmed.startsWith("data:image/");
        const isHttpImage = /^https?:\/\//i.test(trimmed);
        return startsWithSvg || isEmoji || isDataImage || isHttpImage;
      },
      {
        message:
          'Icon must be: (1) PNG/JPEG as data:image/...;base64,... or https URL, (2) inline SVG, or (3) a valid emoji. Plain text like "chart" is not allowed. ' +
          'See docs/design/papr-mini-app-droplet.png for the Papr droplet brand standard.',
      },
    )
    .describe(
      "**REQUIRED:** Mini-app icon (tabs, apps grid, favorites). " +
        "**Brand standard (preferred):** One 3D liquid-glass water droplet on pure white, one subject inside, Apple-keynote aesthetic — see `docs/design/papr-mini-app-droplet.png`. " +
        "Master prompt: `Create a minimalist premium icon on a pure white background. Show one perfect transparent water droplet sphere, centered, with soft glass-like edges, subtle reflections, delicate refraction, and a polished Apple-keynote aesthetic. Inside the droplet, place [SUBJECT]. No text, no extra objects, no multiple droplets, no clutter. Lots of whitespace.` " +
        "Append: pure white background; one droplet only; one subject only; centered; no text; minimal soft shadow only. " +
        "Output 512×512 PNG as `data:image/png;base64,...`. " +
        "Fallbacks: compact SVG with stroke=currentColor (renders inside the in-app glass orb) or emoji. " +
        "Anti-patterns: flat blue gradient orbs, busy scenes, gray backgrounds, multiple bubbles.",
    ),
  files: z.array(appFileSchema).optional(),
  html: z.string().optional(),
  css: z.string().optional(),
  javascript: z.string().optional(),
});

const dependencySchema = z.object({
  jobId: z.string().min(1),
  onStatus: z.enum(["completed", "failed"]).default("completed"),
  autoTrigger: z
    .boolean()
    .optional()
    .describe(
      "REQUIRED for automatic pipeline chaining: set true so this job starts by itself when the parent job reaches onStatus (e.g. completed). " +
        "If omitted or false, dependsOn only enforces order when something else starts this job (manual run_job, schedule, or running a downstream job that pulls the chain). " +
        "Every link in a fire-and-forget chain (A finishes → run B → B finishes → run C) needs autoTrigger: true on B's dependency on A and on C's dependency on B. " +
        "update_job: if you replace dependsOn without autoTrigger, auto-start is removed.",
    ),
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

const recipeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoEvaluate: z.boolean().optional().default(true).describe(
    "Automatically evaluate each run against the recipe on completion"
  ),
  passThreshold: z.number().min(0).max(1).optional().default(0.7).describe(
    "Minimum score (0-1) for a run to pass evaluation"
  ),
  evaluatorProvider: z.enum(["openai", "anthropic", "google", "ollama"]).optional(),
  evaluatorModel: z.string().optional(),
});

const createJobSchema = z.object({
  name: z.string().min(1),
  type: z.enum([
    "shell",
    "bash",
    "node",
    "python",
    "swift",
    "agent",
    "subagent",
  ]),
  folder: z
    .string()
    .optional()
    .describe(
      "Folder label to group related jobs (e.g. 'ingestion', 'processing', 'reporting'). " +
        "Use list_job_folders first to see existing groups. Same name = same folder.",
    ),
  command: z.string().optional(),
  requirements: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Python/Node packages to install before running. Creates a venv automatically. Example: ['anthropic', 'requests', 'sqlite-utils']",
    ),
  dependsOn: z
    .array(dependencySchema)
    .optional()
    .describe(
      "Upstream jobs. Use autoTrigger: true on each entry when this job should start automatically when the parent reaches onStatus (required for A→B→C chains).",
    ),
  runtimeCalls: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Job IDs this job calls at runtime via HTTP (POST /api/jobs/run). " +
        "Used for visualization only (shows dashed arrows in graph). " +
        "Example: ['agent_summarizer', 'data_validator']",
    ),
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
  provider: z
    .enum(["openai", "anthropic", "google", "ollama"])
    .optional()
    .describe(
      "Provider for agent/subagent jobs. Overrides default. Example: 'openai', 'anthropic', 'ollama'",
    ),
  model: z
    .enum([
      // Anthropic
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      // OpenAI
      "gpt-5.4-mini",
      "gpt-5.5-low",
      "gpt-5.5",
      "gpt-5.5-high",
      "gpt-5.3-codex",
      // Google
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      // Ollama - Qwen
      "qwen3.5:0.8b",
      "qwen3.5:2b",
      "qwen3.5:4b-q4_k_m",
      "qwen3.5:latest",
      "qwen3.5:9b-q4_k_m",
      "qwen3.5:27b",
      // Ollama - Gemma
      "gemma3:270m",
      "gemma3:1b",
      "gemma3:4b-it-q4_k_m",
      "gemma3:4b-it-qat",
      "gemma3:latest",
      "gemma3:12b-it-q4_k_m",
      "gemma3:27b",
    ])
    .optional()
    .describe(
      "Model ID for agent/subagent jobs. Must match exact model ID. Recommended: 'claude-sonnet-4-6', 'gpt-5.5', 'gemini-2.5-flash', 'qwen3.5:latest'",
    ),
  recipe: recipeConfigSchema.optional().describe(
    "Execution recipe configuration. When enabled, an agent evaluates each run against the recipe's quality rubric. " +
    "Use write_recipe to set the actual recipe content (markdown with intent, criteria, rubric, anti-patterns, edge cases)."
  ),
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
    pathMod.default.resolve(
      thisDir,
      "../../resources/app-templates/liquid-glass-base.css",
    ),
    pathMod.default.resolve(
      thisDir,
      "../../../src/resources/app-templates/liquid-glass-base.css",
    ),
    pathMod.default.resolve(
      process.cwd(),
      "src/resources/app-templates/liquid-glass-base.css",
    ),
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

function resolveAppFiles(
  args: CreateAppArgs,
): Array<{ filename: string; content: string }> {
  if (args.files && args.files.length > 0) {
    return args.files;
  }

  const html =
    args.html ??
    '<!doctype html>\n<html>\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="app.ts"></script>\n</body>\n</html>';
  const css = args.css ?? null; // Will be resolved async in the tool execute
  const javascript =
    args.javascript ??
    "const app = document.getElementById('app');\nif (app) {\n  app.textContent = 'App initialized';\n}\n";

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
  description:
    "Create a mini-app artifact with one or more files. Uses TypeScript (.ts) and Liquid Glass design system by default.",
  inputSchema: createAppSchema,
  execute: async (input) => {
    const args = (input as { context?: CreateAppArgs }).context ?? input;
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();

    const files = resolveAppFiles(args);

    // Auto-inject Liquid Glass base CSS if no style.css was provided
    const hasStylesheet = files.some((f) => f.filename === "style.css");
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
    return {
      success: true,
      data: app,
      _designReminder:
        `⚠️ DESIGN REQUIREMENT: You MUST load the design system skill BEFORE writing any UI code: ` +
        `read_skill({ skillId: "preloaded-paprwork-design-system" }). ` +
        `Design target: Steve Jobs meets Elon Musk — obsessively clean, premium, zero clutter. ` +
        `2-3 focused sections max, ONE primary action per screen, generous whitespace. ` +
        `Follow these principles unless the user has explicitly provided different design guidelines.`,
    };
  },
});

export const createJobTool = createTool({
  id: "create_job",
  description:
    "Create a job with optional DAG dependencies, retries, and delivery. " +
    "For pipelines that should run automatically when a parent job finishes, each dependsOn entry MUST include autoTrigger: true (same for subagent→subagent as python→subagent). " +
    "Without autoTrigger, dependencies only order runs when you start the job another way. " +
    "\n\nAgent job model selection: " +
    "Use 'provider' and 'model' fields for direct override (type: 'agent', same behavior, just different model). " +
    "Use subagent (type: 'subagent' with subAgentId) when you need custom system prompt or restricted tools. " +
    "Priority: subagent profile > job model override > default (gpt-5.4).",
  inputSchema: createJobSchema,
  execute: async (input) => {
    const args = (input as { context?: CreateJobArgs }).context ?? input;
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
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
        ...(dependency.autoTrigger ? { autoTrigger: true } : {}),
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
      provider: args.provider,
      model: args.model,
      recipe: args.recipe,
    });

    const isScriptJob = ["python", "node", "bash", "shell", "swift"].includes(
      args.type,
    );
    const commandUsesKeySubstitution = args.command?.includes("${");

    const keyReminder =
      isScriptJob && !commandUsesKeySubstitution
        ? `⚠️ API KEY REMINDER: If this job uses custom API keys from Settings, you MUST pass them as CLI args using \${KEY_NAME} in the command field. ` +
          `Example: command: "python3 code/main.py --api-key \${MY_KEY}" + argparse in script. ` +
          `Do NOT use os.environ.get() or process.env — custom keys are NOT available as environment variables. ` +
          `Load the guide: read_skill({ skillId: "preloaded-api-key-testing" })`
        : undefined;

    return {
      success: true,
      data: job,
      ...(keyReminder ? { _keyPatternReminder: keyReminder } : {}),
    };
  },
});

/**
 * Scan job source files for the anti-pattern of using os.environ/process.env
 * to access custom API keys. Custom keys from Settings are stored in the system
 * keychain and are NOT available as environment variables in job processes.
 * They must be passed via CLI arguments using ${KEY_NAME} in the command field.
 */
async function scanJobSourceForEnvKeyAntiPattern(
  jobId: string,
): Promise<string[]> {
  const { promises: fsP } = await import("fs");
  const pathMod = await import("path");
  const warnings: string[] = [];
  const jobDir = await getJobDir(jobId);

  const inheritedEnvKeys = new Set([
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "PAPR_API_KEY",
    "JOB_DIR",
    "JOB_DB",
    "THREAD_ID",
    "ACTION",
    "PATH",
    "HOME",
    "USER",
    "NODE_ENV",
  ]);

  const looksLikeApiKey = (name: string): boolean => {
    const upper = name.toUpperCase();
    return /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|_URL$)/.test(upper);
  };

  const scanDir = async (dir: string, prefix: string): Promise<void> => {
    try {
      const entries = await fsP.readdir(dir);
      for (const entry of entries) {
        if (
          entry.startsWith(".") ||
          ["node_modules", "__pycache__", "data", ".venv", "venv"].includes(
            entry,
          )
        )
          continue;
        const fullPath = pathMod.default.join(dir, entry);
        const stat = await fsP.stat(fullPath);

        if (stat.isDirectory()) {
          await scanDir(fullPath, prefix ? `${prefix}/${entry}` : entry);
          continue;
        }

        if (!/\.(py|js|ts|mjs)$/.test(entry)) continue;
        if (stat.size > 100_000) continue;

        const content = await fsP.readFile(fullPath, "utf-8");
        const relPath = prefix ? `${prefix}/${entry}` : entry;

        const pyPatterns = [
          /os\.environ\.get\(\s*['"]([^'"]+)['"]/g,
          /os\.getenv\(\s*['"]([^'"]+)['"]/g,
          /os\.environ\[\s*['"]([^'"]+)['"]/g,
        ];
        for (const pattern of pyPatterns) {
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(content)) !== null) {
            if (!inheritedEnvKeys.has(match[1]) && looksLikeApiKey(match[1])) {
              warnings.push(
                `${relPath}: \`${match[0]})\` — "${match[1]}" is a custom key from Settings and is NOT available as an env var. ` +
                  `Fix: pass it via CLI arg in the job command using \${${match[1]}} and use argparse in the script.`,
              );
            }
          }
        }

        const nodePatterns = [
          /process\.env\.(\w+)/g,
          /process\.env\[\s*['"]([^'"]+)['"]\s*]/g,
        ];
        for (const pattern of nodePatterns) {
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(content)) !== null) {
            const key = match[1] || match[2];
            if (!inheritedEnvKeys.has(key) && looksLikeApiKey(key)) {
              warnings.push(
                `${relPath}: \`${match[0]}\` — "${key}" is a custom key from Settings and is NOT available as an env var. ` +
                  `Fix: pass it via CLI arg in the job command using \${${key}} and read from process.argv.`,
              );
            }
          }
        }
      }
    } catch {
      // directory doesn't exist or can't be read
    }
  };

  await scanDir(jobDir, "");
  return warnings;
}

export const runJobTool = createTool({
  id: "run_job",
  description: "Run a job by id and return status/logs/database info",
  inputSchema: runJobSchema,
  execute: async (input) => {
    const args = (input as { context?: RunJobArgs }).context ?? input;
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    // Scan source files for env key anti-patterns before running
    const envKeyWarnings =
      await scanJobSourceForEnvKeyAntiPattern(args.jobId);

    const job = await jobsService.runJob(args.jobId);
    const apiKeys = getApiKeysForSanitization();
    const logs = sanitizeError(
      await jobsService.getLogs(args.jobId, args.logBytes ?? 12000),
      apiKeys,
    );
    const dbPath = await jobsService.getJobDatabasePath(args.jobId);

    // Return special format for UI to render JobStatusCard
    return {
      success: true,
      data: {
        type: "job_status",
        jobId: job.id,
        jobName: job.name,
        runId: job.lastExecutionId || "latest",
        status: job.status,
        startedAt: job.lastRunAt || new Date().toISOString(),
        logs: logs.split("\n").slice(-10),
        job,
        dbPath,
        ...(envKeyWarnings.length > 0
          ? {
              _envKeyWarnings: envKeyWarnings,
              _keyPatternReminder:
                `⚠️ DETECTED: Source files use os.environ/process.env for custom API keys that are NOT available as env vars. ` +
                `Custom keys from Settings must be passed via CLI args using \${KEY_NAME} in the job command field. ` +
                `This job will likely fail with None/undefined for those keys. ` +
                `Fix: update_job to add \${KEY_NAME} to the command, update the script to use argparse/process.argv. ` +
                `Read: read_skill({ skillId: "preloaded-api-key-testing" })`,
            }
          : {}),
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
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
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
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
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
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
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

const readAppFileSchema = toolSchemaWithFilenameAlias(
  z.object({
    appId: z.string().min(1).describe("App UUID"),
    filename: z
      .string()
      .min(1)
      .describe("Filename to read (e.g. index.html, style.css, app.js)"),
  }),
);

const editAppFileSchema = toolSchemaWithFilenameAlias(
  z.object({
    appId: z.string().min(1).describe("App UUID"),
    filename: z.string().min(1).describe("Filename to edit"),
    oldString: z.string().min(1).describe("Exact string to find in the file"),
    newString: z
      .string()
      .describe("Replacement string (use empty string to delete)"),
  }),
);

const editAppFileLinesSchema = toolSchemaWithFilenameAlias(
  z.object({
    appId: z.string().min(1).describe("App UUID"),
    filename: z
      .string()
      .min(1)
      .describe("Filename to edit (e.g. index.html, style.css, app.js)"),
    startLine: z
      .number()
      .int()
      .min(1)
      .describe("Starting line number (1-indexed, inclusive)"),
    endLine: z
      .number()
      .int()
      .min(1)
      .describe("Ending line number (1-indexed, inclusive)"),
    newContent: z
      .string()
      .describe(
        "New content to replace lines startLine through endLine. Use empty string to delete the lines.",
      ),
  }),
);

const listAppFilesSchema = z.object({
  appId: z.string().min(1).describe("App UUID"),
});

const listAppsSchema = z.object({
  includeCompleted: z
    .boolean()
    .optional()
    .describe("Include completed/archived apps (default: false)"),
});

const updateJobSchema = z.object({
  jobId: z
    .string()
    .min(1)
    .describe("ID of the job to update (get it from list_jobs)"),
  name: z.string().min(1).optional().describe("New display name for the job"),
  folder: z
    .string()
    .optional()
    .describe(
      "Assign or change the job's folder group (e.g. 'ingestion'). Use set_job_folder for a dedicated tool.",
    ),
  command: z
    .string()
    .optional()
    .describe("New command to run (e.g. 'python3 selector.py')"),
  requirements: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Updated Python/Node packages. Rewrites requirements.txt immediately. Pass [] to clear.",
    ),
  dependsOn: z
    .array(dependencySchema)
    .optional()
    .describe(
      "Replace the full dependency list. Include autoTrigger: true on each entry that should auto-run when the parent completes; omitted flags are not stored.",
    ),
  retries: retrySchema.optional().describe("Update retry policy"),
  retentionDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("How many days to keep job data"),
  schedule: scheduleSchema.optional().describe("Update or set a schedule"),
  outputMode: z
    .enum(["natural", "structured"])
    .optional()
    .describe("Change output mode"),
  outputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Update structured output schema"),
  maxTurns: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Update max turns for agent jobs"),
  memoryPolicy: z
    .enum(["none", "summary", "full"])
    .optional()
    .describe("Update memory policy for agent jobs"),
  reportChatId: z
    .string()
    .min(1)
    .optional()
    .describe("Update which chat receives job results"),
  provider: z
    .enum(["openai", "anthropic", "google", "ollama"])
    .optional()
    .describe(
      "Update provider for agent/subagent jobs. Example: 'openai', 'anthropic', 'ollama'",
    ),
  model: z
    .enum([
      // Anthropic
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      // OpenAI
      "gpt-5.4-mini",
      "gpt-5.5-low",
      "gpt-5.5",
      "gpt-5.5-high",
      "gpt-5.3-codex",
      // Google
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      // Ollama - Qwen
      "qwen3.5:0.8b",
      "qwen3.5:2b",
      "qwen3.5:4b-q4_k_m",
      "qwen3.5:latest",
      "qwen3.5:9b-q4_k_m",
      "qwen3.5:27b",
      // Ollama - Gemma
      "gemma3:270m",
      "gemma3:1b",
      "gemma3:4b-it-q4_k_m",
      "gemma3:4b-it-qat",
      "gemma3:latest",
      "gemma3:12b-it-q4_k_m",
      "gemma3:27b",
    ])
    .optional()
    .describe(
      "Update model ID for agent/subagent jobs. Must match exact model ID. Recommended: 'claude-sonnet-4-6', 'gpt-5.5', 'gemini-2.5-flash', 'qwen3.5:latest'",
    ),
});

const deleteJobSchema = z.object({
  jobId: z.string().min(1).describe("ID of the job to delete"),
  deleteFiles: z
    .boolean()
    .optional()
    .describe(
      "Also delete the job's directory (scripts, logs, database). Default: false — keeps files on disk but removes the job from the index.",
    ),
});

const listJobsSchema = z.object({
  status: z
    .enum(["pending", "running", "completed", "failed", "cancelled"])
    .optional()
    .describe("Filter by status. Omit to return all jobs."),
  type: z
    .enum(["shell", "bash", "node", "python", "swift", "agent", "subagent"])
    .optional()
    .describe("Filter by runtime type."),
  folder: z
    .string()
    .optional()
    .describe(
      "Filter to jobs in this folder (e.g. 'ingestion'). Use list_job_folders to see available folders.",
    ),
  appId: z
    .string()
    .optional()
    .describe("Filter to jobs linked to this app ID via data-sources."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max jobs to return (default: 50, newest first)."),
});

const listJobFilesSchema = z.object({
  jobId: z.string().min(1).describe("Job UUID"),
});

const readJobFileSchema = toolSchemaWithFilenameAlias(
  z.object({
    jobId: z.string().min(1).describe("Job UUID"),
    filename: z
      .string()
      .min(1)
      .describe(
        "Filename relative to the job directory (e.g. selector.py, requirements.txt)",
      ),
  }),
);

const editJobFileSchema = toolSchemaWithFilenameAlias(
  z.object({
    jobId: z.string().min(1).describe("Job UUID"),
    filename: z
      .string()
      .min(1)
      .describe("Filename to edit (relative to job directory)"),
    oldString: z
      .string()
      .min(1)
      .describe(
        "Exact string to find and replace. Must match character-for-character including whitespace.",
      ),
    newString: z
      .string()
      .describe(
        "Replacement string. Use empty string to delete the matched section.",
      ),
  }),
);

type ReadAppFileArgs = z.infer<typeof readAppFileSchema>;
type EditAppFileArgs = z.infer<typeof editAppFileSchema>;
type EditAppFileLinesArgs = z.infer<typeof editAppFileLinesSchema>;
type ListAppFilesArgs = z.infer<typeof listAppFilesSchema>;

export const readAppFileTool = createTool({
  id: "read_app_file",
  description: "Read a specific file from a mini-app by filename",
  inputSchema: readAppFileSchema,
  execute: async (input) => {
    const args = (input as { context?: ReadAppFileArgs }).context ?? input;
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
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
  description:
    "Edit a mini-app file by replacing an exact string occurrence with a new string",
  inputSchema: editAppFileSchema,
  execute: async (input) => {
    const args = (input as { context?: EditAppFileArgs }).context ?? input;
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
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

export const editAppFileLinesTool = createTool({
  id: "edit_app_file_lines",
  description: `Edit a mini-app file by replacing a range of lines with new content.
This is more reliable than edit_app_file for code changes because:
- Line numbers are unambiguous (no string matching issues)
- You can read the file first to see exact line numbers
- Works even with special characters, escape sequences, etc.

Workflow:
1. read_app_file to see the content with line numbers
2. edit_app_file_lines to replace specific line range
3. Verify with read_app_file or webview_snapshot

Example: Replace lines 168-215 in index.html with new HTML structure`,
  inputSchema: editAppFileLinesSchema,
  execute: async (input) => {
    const args = (input as { context?: EditAppFileLinesArgs }).context ?? input;
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();

    const content = await appService.readAppFile(args.appId, args.filename);
    if (content === null) {
      throw new Error(`File not found: ${args.filename} in app ${args.appId}`);
    }

    const lines = content.split("\n");
    const totalLines = lines.length;

    // Validate line numbers
    if (args.startLine < 1) {
      throw new Error(
        `Invalid startLine: ${args.startLine}. Line numbers start at 1.`,
      );
    }
    if (args.endLine < args.startLine) {
      throw new Error(
        `Invalid range: startLine ${args.startLine} > endLine ${args.endLine}`,
      );
    }
    if (args.startLine > totalLines) {
      throw new Error(
        `startLine ${args.startLine} exceeds file length (${totalLines} lines). Use read_app_file to see current content.`,
      );
    }
    if (args.endLine > totalLines) {
      throw new Error(
        `endLine ${args.endLine} exceeds file length (${totalLines} lines). File has ${totalLines} lines.`,
      );
    }

    // Convert to 0-indexed for array operations
    const startIdx = args.startLine - 1;
    const endIdx = args.endLine; // endLine is inclusive, so this is the line after the last one to replace

    // Build new content
    const before = lines.slice(0, startIdx);
    const after = lines.slice(endIdx);
    const newLines = args.newContent ? args.newContent.split("\n") : [];

    const newContent = [...before, ...newLines, ...after].join("\n");

    await appService.writeAppFile(args.appId, args.filename, newContent);

    const newTotalLines = newContent.split("\n").length;
    const linesRemoved = args.endLine - args.startLine + 1;
    const linesAdded = newLines.length;
    const netChange = linesAdded - linesRemoved;

    return {
      success: true,
      data: {
        filename: args.filename,
        updated: true,
        originalLines: totalLines,
        newLines: newTotalLines,
        linesRemoved,
        linesAdded,
        netChange,
        tip:
          netChange !== 0
            ? `File now has ${newTotalLines} lines (${netChange > 0 ? "+" : ""}${netChange}). Line numbers after ${args.startLine} have shifted.`
            : `File still has ${newTotalLines} lines. Line numbers unchanged.`,
      },
    };
  },
});

export const listAppFilesTool = createTool({
  id: "list_app_files",
  description: "List all files in a mini-app",
  inputSchema: listAppFilesSchema,
  execute: async (input) => {
    const args = (input as { context?: ListAppFilesArgs }).context ?? input;
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
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
      "Papr",
      "apps",
      args.appId,
    );
    const entries = await fsPromises.readdir(appDir);
    const files = entries.filter(
      (e) => !e.startsWith(".") && e !== "data-sources.json" && e !== ".versions",
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
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
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

const deleteAppSchema = z.object({
  appId: z
    .string()
    .min(1)
    .describe("UUID of the mini-app to remove from the catalog and disk"),
});

type DeleteAppArgs = z.infer<typeof deleteAppSchema>;

export const deleteAppTool = createTool({
  id: "delete_app",
  description: `Delete a mini-app by id. Removes the app from ~/Papr/data/apps.json, deletes ~/Papr/apps/{id}/, and notifies the UI.

**Prefer this over bash/rm** when removing an app: deleting files only leaves stale entries in the apps list until the registry is reconciled.`,
  inputSchema: deleteAppSchema,
  execute: async (input) => {
    const args = (input as { context?: DeleteAppArgs }).context ?? input;
    const startTime = performance.now();
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();
    const deleted = await appService.deleteApp(args.appId);
    if (!deleted) {
      return {
        success: false,
        error: `App not found: ${args.appId}`,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
    return {
      success: true,
      data: { deleted: true, appId: args.appId },
      duration: performance.now() - startTime,
      timestamp: new Date().toISOString(),
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
- Change a dependency: { jobId, dependsOn: [{ jobId: "...", onStatus: "completed", autoTrigger: true }] } — include autoTrigger: true whenever the job should start automatically when the parent completes; omitting it removes auto-chaining
- Enable/change a schedule: { jobId, schedule: { enabled: true, cron: "0 9 * * *" } }
- Disable a schedule: { jobId, schedule: { enabled: false } } — job still exists but won't run automatically
- Adjust retries after a flaky run: { jobId, retries: { maxAttempts: 3, backoffMs: 5000 } }`,
  inputSchema: updateJobSchema,
  execute: async (input) => {
    const args = (input as { context?: UpdateJobArgs }).context ?? input;
    const { jobId, dependsOn, retries, schedule, folder, ...rest } = args;
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
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
              ...(d.autoTrigger ? { autoTrigger: true } : {}),
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
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const result = await jobsService.deleteJob(
      args.jobId,
      args.deleteFiles ?? false,
    );
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
  return pathModule.default.join(
    osModule.default.homedir(),
    "Papr",
    "jobs",
    jobId,
  );
}

/**
 * Save a version snapshot of a job file before overwriting.
 * Stored in ~/Papr/jobs/{jobId}/.versions/{filename}/{timestamp}_{reason}
 */
async function saveJobFileVersion(
  jobId: string,
  filename: string,
  content: string,
  reason: string = "auto",
): Promise<string> {
  const { promises: fsP } = await import("fs");
  const pathModule = await import("path");
  const jobDir = await getJobDir(jobId);

  const safeFilename = filename.replace(/\//g, "__");
  const versionsDir = pathModule.default.join(jobDir, ".versions", safeFilename);
  await fsP.mkdir(versionsDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const versionId = `${safeTimestamp}_${reason}`;

  // Deduplicate: check if latest version is identical
  try {
    const existing = await fsP.readdir(versionsDir);
    if (existing.length > 0) {
      const sorted = existing.sort().reverse();
      const latestContent = await fsP.readFile(
        pathModule.default.join(versionsDir, sorted[0]),
        "utf-8",
      );
      if (latestContent === content) {
        return sorted[0];
      }
    }
  } catch {
    /* first version */
  }

  await fsP.writeFile(
    pathModule.default.join(versionsDir, versionId),
    content,
    "utf-8",
  );
  console.log(`[Jobs] Saved version ${versionId} for ${jobId}/${filename}`);
  return versionId;
}

export const listJobFilesTool = createTool({
  id: "list_job_files",
  description:
    "List all files in a job's directory — scripts, logs, requirements.txt, etc. Use this before read_job_file or edit_job_file to confirm filenames.",
  inputSchema: listJobFilesSchema,
  execute: async (input) => {
    const args = (input as { context?: ListJobFilesArgs }).context ?? input;
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
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
          if (item.name === ".versions") continue;
          const rel = base ? `${base}/${item.name}` : item.name;
          if (item.isDirectory()) {
            const sub = await walk(
              pathModule.default.join(dir, item.name),
              rel,
            );
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
    console.log(
      `[list_job_files] Found ${files.length} file(s) for job ${args.jobId}`,
    );

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
  description:
    "Read a source file from a job's directory (e.g. the Python/Node script). Use list_job_files first to confirm the filename.",
  inputSchema: readJobFileSchema,
  execute: async (input) => {
    const args = (input as { context?: ReadJobFileArgs }).context ?? input;
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
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
    if (
      !resolvedPath.startsWith(resolvedDir + pathModule.default.sep) &&
      resolvedPath !== resolvedDir
    ) {
      throw new Error(`Path traversal rejected: ${args.filename}`);
    }

    console.log(`[read_job_file] Reading ${resolvedPath}`);

    let content: string;
    try {
      content = await fsPromises.readFile(resolvedPath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new Error(
          `File not found: ${args.filename} in job ${args.jobId}. Call list_job_files to see what exists.`,
        );
      }
      throw err;
    }

    console.log(
      `[read_job_file] Read ${content.length} chars from ${args.filename}`,
    );
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
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    const job = await jobsService.getJob(args.jobId);
    if (!job) {
      throw new Error(`Job not found: ${args.jobId}`);
    }
    if (job.status === "running") {
      throw new Error(
        `Job ${args.jobId} is currently running. Wait for it to finish before editing its files.`,
      );
    }

    const { promises: fsPromises } = await import("fs");
    const pathModule = await import("path");
    const jobDir = await getJobDir(args.jobId);
    const filePath = pathModule.default.join(jobDir, args.filename);

    // Safety: path traversal guard
    const resolvedPath = pathModule.default.resolve(filePath);
    const resolvedDir = pathModule.default.resolve(jobDir);
    if (
      !resolvedPath.startsWith(resolvedDir + pathModule.default.sep) &&
      resolvedPath !== resolvedDir
    ) {
      throw new Error(`Path traversal rejected: ${args.filename}`);
    }

    console.log(`[edit_job_file] Editing ${resolvedPath}`);

    let content: string;
    try {
      content = await fsPromises.readFile(resolvedPath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new Error(
          `File not found: ${args.filename} in job ${args.jobId}. Call list_job_files to see what exists.`,
        );
      }
      throw err;
    }

    if (!content.includes(args.oldString)) {
      console.error(
        `[edit_job_file] oldString not found in ${args.filename}. File length: ${content.length} chars.`,
      );
      throw new Error(
        `String not found in ${args.filename}. The oldString must match exactly including whitespace and indentation. ` +
          `Use read_job_file to get the current content first.`,
      );
    }

    const occurrences = content.split(args.oldString).length - 1;
    if (occurrences > 1) {
      console.warn(
        `[edit_job_file] oldString appears ${occurrences} times in ${args.filename} — replacing first occurrence only`,
      );
    }

    // Save version before editing
    await saveJobFileVersion(args.jobId, args.filename, content, "before-edit");

    const newContent = content.replace(args.oldString, args.newString);
    await fsPromises.writeFile(resolvedPath, newContent, "utf8");

    console.log(
      `[edit_job_file] Successfully patched ${args.filename} (${occurrences} occurrence replaced)`,
    );

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
- Detect jobs stuck in waiting_permission (need API key approval) — check waitingPermissionKeys
- See schedule status: schedule.enabled: true (scheduled), schedule.enabled: false (disabled), schedule: undefined (never scheduled)
Returns jobs sorted newest-first. Filter by status or type as needed.

IMPORTANT: Jobs with schedule.enabled: false are NOT deleted or broken — they can still run manually or via dependencies. They just won't run automatically on a schedule.`,
  inputSchema: listJobsSchema,
  execute: async (input) => {
    const args = (input as { context?: ListJobsArgs }).context ?? input;
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    let jobs = await jobsService.listJobs(
      (args.folder ?? args.appId)
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
    const jobsRoot = pathModule.default.join(
      osModule.default.homedir(),
      "Papr",
      "jobs",
    );

    const jobsSummary = jobs.map((j) => ({
      id: j.id,
      name: j.name,
      type: j.type,
      status: j.status,
      waitingPermissionKeys:
        j.status === "waiting_permission" ? j.waitingPermissionKeys : undefined,
      folder: j.folder,
      command: j.command,
      requirements: j.requirements?.length ? j.requirements : undefined,
      dependsOn: j.dependsOn?.length
        ? j.dependsOn.map((d) => ({
            jobId: d.jobId,
            onStatus: d.onStatus,
            ...(d.autoTrigger ? { autoTrigger: true } : {}),
          }))
        : undefined,
      schedule: j.schedule
        ? {
            enabled: j.schedule.enabled,
            cron: j.schedule.cron,
            intervalMs: j.schedule.intervalMs,
            atTime: j.schedule.atTime,
          }
        : undefined,
      retries:
        j.retries?.maxAttempts && j.retries.maxAttempts > 1
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

const exportAppBundleSchema = z.object({
  appId: z.string().min(1).describe("ID of the app to export"),
  bundleId: z
    .string()
    .optional()
    .describe("Optional bundle ID (auto-generated if not provided)"),
  name: z
    .string()
    .optional()
    .describe(
      "Human-readable name for the app bundle (auto-derived from app title if omitted)",
    ),
  version: z
    .string()
    .default("1.0.0")
    .describe("Semantic version (e.g., 1.0.0)"),
  description: z
    .string()
    .optional()
    .describe("Description of what this app bundle does"),
  jobIds: z
    .array(z.string())
    .optional()
    .describe("Job IDs to include (auto-detects linked jobs if omitted)"),
  includeData: z
    .boolean()
    .default(false)
    .describe(
      "If true, keeps database files, logs, and caches in the bundle (user explicitly wants to share their data). Default false = auto-scrub all private data.",
    ),
  platform: z
    .array(z.enum(["macos", "windows", "linux"]))
    .optional()
    .describe(
      "Target platforms for the bundle. Auto-detected from job types and source files if omitted. Override when you know the app is platform-specific.",
    ),
  requirements: z
    .array(
      z.union([
        z.string().min(1),
        z.object({
          name: z
            .string()
            .min(1)
            .describe("Key name as used in job commands, e.g. POSTHOG_PERSONAL_API_KEY"),
          service: z.string().min(1).describe("Human-readable service name, e.g. PostHog"),
          category: z
            .enum([
              "analytics", "database", "crm", "email", "payments", "storage",
              "messaging", "search", "monitoring", "auth", "ai", "notifications",
              "google", "github", "other",
            ])
            .describe("Service category — enables 'I use a different service' substitution in the import wizard"),
          description: z.string().default("").describe("Short description of what the key is used for"),
          required: z.boolean().default(true).describe("If false, the app works without this key but with reduced functionality"),
          signupUrl: z.string().optional().describe("URL where users can sign up and get an API key"),
          docsUrl: z.string().optional().describe("URL to the service's API key documentation"),
          instructions: z.string().optional().describe("Step-by-step instructions for obtaining the key"),
          freeTier: z.boolean().optional().describe("Whether the service has a free tier"),
          freeTierNote: z.string().optional().describe("Details about the free tier, e.g. '1M events/month free'"),
        }),
      ]),
    )
    .optional()
    .describe(
      "API keys this app needs. Provide rich specs so the import wizard can show setup instructions, " +
      "free-tier info, and alternative services. If omitted, keys are auto-detected from job source files " +
      "as bare strings (no wizard metadata).",
    ),
});

const importAppBundleSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      "Local path or GitHub URL (e.g., github.com/user/repo or ~/Downloads/app-bundle)",
    ),
  subPath: z
    .string()
    .optional()
    .describe(
      "Subdirectory within the repo containing the bundle (e.g., 'bundles/meetings-manager'). Required for community repo imports where the bundle isn't at the repo root.",
    ),
  renameConflicts: z
    .boolean()
    .default(true)
    .describe("Auto-rename if app/job IDs already exist"),
});

const getAppBundleInfoSchema = z.object({
  source: z.string().min(1).describe("Local path or bundleId to preview"),
});

type ExportAppBundleArgs = z.infer<typeof exportAppBundleSchema>;
type ImportAppBundleArgs = z.infer<typeof importAppBundleSchema>;
type GetAppBundleInfoArgs = z.infer<typeof getAppBundleInfoSchema>;

export const exportAppBundleTool = createTool({
  id: "export_app_bundle",
  description: `Export a mini-app with its jobs and database schemas as a portable app bundle.
Creates an app bundle folder at ~/Papr/bundles/{bundleId}/ containing:
- manifest.json: App + job metadata, database schemas
- apps/{appId}/: Mini app HTML/CSS/JS/TS files
- jobs/{jobId}/: Job code, migrations
- README.md: Auto-generated installation instructions
- .gitignore: Excludes large data files

Automatically discovers the FULL job pipeline via three methods: (1) scans app source files for job IDs referenced in code (e.g. fetch('/api/jobs/run', { jobId })), (2) walks dependsOn dependency chains, and (3) walks runtimeCalls chains. All discovered jobs are included — not just the directly linked ones. Check resolvedJobIds in the result.

By default, automatically scrubs private data (databases, logs, WAL files, venvs, caches) from the bundle. The scrub report is returned so you can tell the user what was removed. If the user explicitly wants to share data files (sample datasets, demo databases), set includeData: true.

Use this to share complete mini-apps (with all jobs and schemas) via GitHub, Dropbox, or file transfer.

**Publishing to the Papr Work Community:**
After export, publish the bundle to the official community repo so other Paprwork users can discover and install it:

1. Fork & clone: gh repo fork Papr-ai/paprwork-community-apps --clone --remote (NEVER clone the main repo directly)
2. Copy the exported bundle folder into bundles/{bundleId}/ in the forked clone
3. Add YOUR entry to registry.json — do NOT modify or remove existing entries. IMPORTANT: Use the pre-built "registryEntry" JSON from the export result (just fill in author and tags). All fields are Zod-validated; entries that fail validation are SILENTLY DROPPED and won't appear in Community Apps. Required: bundleId, name, description, version, author (run "gh api user -q .login" to get the actual GitHub username — NEVER hardcode "paprwork-team"), tags (string[]), minPaprworkVersion, path. Optional: icon (string), requirements (array of strings or RequiredKeySpec objects — pass the "requirements" from the manifest as-is), platform (string[] — MUST be a flat string array like ["macos"], NOT a bare string).
4. Commit, push to the fork, then open a PR to Papr-ai/paprwork-community-apps

This makes the app available in Papr Work's "Community Apps" tab for all users.`,
  inputSchema: exportAppBundleSchema,
  execute: async (input) => {
    const args = (input as { context?: ExportAppBundleArgs }).context ?? input;
    const startTime = performance.now();

    try {
      const { getBundleService } =
        await import("../../gateway/services/BundleService.js");
      const { getAppService } =
        await import("../../gateway/services/AppService.js");
      const bundleService = getBundleService();
      const appService = getAppService();
      await bundleService.initialize();
      await appService.initialize();

      let bundleName = args.name;
      if (!bundleName) {
        const app = await appService.getApp(args.appId);
        bundleName = app?.title || `App ${args.appId.slice(0, 8)}`;
      }

      const bundleId = args.bundleId || bundleName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        || `bundle-${Date.now()}`;

      let jobIds = args.jobIds || [];
      if (!jobIds.length) {
        const dataSources = await appService.listAppDataSources(args.appId);
        jobIds = dataSources.map((ds: { jobId: string }) => ds.jobId);
      }

      const {
        manifest,
        scrubReport,
        portabilityReport,
        detectedKeys,
        detectedPlatform,
        resolvedJobIds,
      } = await bundleService.exportBundle({
        appId: args.appId,
        bundleId,
        name: bundleName,
        version: args.version,
        description: args.description,
        jobIds,
        includeData: args.includeData,
        platform: args.platform,
        requirements: args.requirements,
      });

      const osModule = await import("os");
      const pathModule = await import("path");
      const fsModule = await import("fs/promises");
      const bundlePath = pathModule.default.join(
        osModule.default.homedir(),
        "Papr",
        "bundles",
        bundleId,
      );

      // Hard block: if hardcoded secrets found, delete the bundle and force the agent to fix them
      if (scrubReport.leakedSecrets.length > 0) {
        await fsModule.rm(bundlePath, { recursive: true, force: true });
        const secretsList = scrubReport.leakedSecrets
          .map((s) => `  ${s.file}:${s.line} — ${s.pattern}`)
          .join("\n");
        throw new Error(
          `Export BLOCKED: Found ${scrubReport.leakedSecrets.length} hardcoded secret(s) in app/job source files. ` +
            `The bundle has been deleted to prevent accidental sharing.\n\n` +
            `Locations:\n${secretsList}\n\n` +
            `Fix: Replace each hardcoded value with the \${KEY_NAME} substitution pattern, then re-export. ` +
            `Example: replace "sk-proj-abc123..." with \${OPENAI_API_KEY} in the job command, ` +
            `and use argparse/sys.argv in the script to receive it.`,
        );
      }

      const scrubSummary =
        scrubReport.removedFiles.length + scrubReport.removedDirs.length > 0
          ? `\n## Privacy Scrub\n\nThe following private data was automatically removed during export:\n${[...scrubReport.removedFiles, ...scrubReport.removedDirs.map((d) => `${d}/`)].map((f) => `- ${f}`).join("\n")}\n\nTotal removed: ${(scrubReport.totalBytesRemoved / 1024).toFixed(1)}KB\n`
          : "";

      const readmeContent = `# ${bundleName}

${args.description || ""}

## Installation

### Option 1: Import via Papr Work Agent
\`\`\`
Agent: "Import the bundle from ${bundlePath}"
\`\`\`

### Option 2: Import from GitHub
1. Push this bundle to GitHub
2. Share the URL with others
3. They import: "Import the bundle from github.com/username/repo"

## Contents

- **App**: ${manifest.app.name} (${manifest.app.id})
- **Jobs**: ${manifest.jobs.length} job(s)
${manifest.jobs.map((j) => `  - ${j.name} (${j.type})`).join("\n")}

## Requirements

- Papr Work v${manifest.minPaprworkVersion} or later
${manifest.jobs.some((j) => j.type === "python") ? "- Python 3.8+ for Python jobs" : ""}
${manifest.jobs.some((j) => j.type === "node") ? "- Node.js 18+ for Node jobs" : ""}

## Version

${args.version} - Created ${new Date().toISOString().split("T")[0]}
`;

      await fsModule.writeFile(
        pathModule.default.join(bundlePath, "README.md"),
        readmeContent,
        "utf8",
      );

      const gitignoreContent = `# Databases (contain user data)
**/*.db
**/*.db-shm
**/*.db-wal
**/*.sqlite
**/*.sqlite3

# Logs (may contain private info)
**/*.log
**/logs/

# Python virtual environments
**/.venv/
**/venv/
**/__pycache__/

# Node modules
**/node_modules/

# Version history
**/.versions/

# Data directories
**/data/

# Paprwork editor backups
**/*.backup.*

# OS files
.DS_Store
Thumbs.db
`;

      await fsModule.writeFile(
        pathModule.default.join(bundlePath, ".gitignore"),
        gitignoreContent,
        "utf8",
      );

      const scrubNote =
        scrubReport.removedFiles.length + scrubReport.removedDirs.length > 0
          ? ` Privacy scrub removed ${scrubReport.removedFiles.length} file(s) and ${scrubReport.removedDirs.length} dir(s) totaling ${(scrubReport.totalBytesRemoved / 1024).toFixed(1)}KB (databases, logs, venvs, caches).`
          : " No private data files found to scrub.";

      const portabilityNote = portabilityReport.portable
        ? " Portability check passed — no hardcoded paths found."
        : ` PORTABILITY WARNING: Found ${portabilityReport.warnings.length} hardcoded path(s) that will break on other machines. You MUST fix these before publishing:\n${portabilityReport.warnings.map((w) => `  - ${w.file}:${w.line}: ${w.issue} → "${w.snippet}"`).join("\n")}`;

      const keysNote =
        detectedKeys.length > 0
          ? ` Auto-detected API key requirements: ${detectedKeys.join(", ")}. These have been added to the manifest. Use these as the "requirements" array in registry.json when publishing.`
          : " No API keys detected — if the bundle needs keys, add them to the registry.json requirements manually.";

      const allPlatforms = ["macos", "windows", "linux"] as const;
      const isUniversal =
        detectedPlatform.length === allPlatforms.length &&
        allPlatforms.every((p) =>
          (detectedPlatform as readonly string[]).includes(p),
        );
      const platformJson = detectedPlatform
        .map((p: string) => '"' + p + '"')
        .join(", ");
      const platformNote = isUniversal
        ? " Platform: cross-platform (all platforms supported)."
        : ` Platform: ${detectedPlatform.join(", ")} only. This bundle uses platform-specific features. Include "platform": [${platformJson}] in registry.json.`;

      const pipelineNote =
        resolvedJobIds.length > jobIds.length
          ? ` Pipeline auto-discovery: found ${resolvedJobIds.length} total jobs (${resolvedJobIds.length - jobIds.length} additional upstream jobs discovered via dependsOn/runtimeCalls). All ${resolvedJobIds.length} jobs included in the bundle.`
          : "";

      const appRecord = await appService.getApp(args.appId);
      const registryEntry = {
        bundleId,
        name: bundleName,
        description: args.description || manifest.description || "",
        version: args.version,
        author: "<FILL_IN: run 'gh api user -q .login' to get your GitHub username>",
        tags: [] as string[],
        minPaprworkVersion: "2.0.0",
        path: `bundles/${bundleId}`,
        icon: appRecord?.icon ?? "",
        requirements: detectedKeys,
        platform: detectedPlatform,
      };

      return {
        success: true,
        data: {
          bundleId,
          bundlePath,
          manifest,
          scrubReport,
          portabilityReport,
          detectedKeys,
          detectedPlatform,
          resolvedJobIds,
          seedJobIds: jobIds,
          registryEntry,
          privacyScrub: scrubSummary || "No private data found.",
          tip: `App bundle exported to ${bundlePath}.${scrubNote}${portabilityNote}${keysNote}${platformNote}${pipelineNote} To publish to the Paprwork community: 1) gh repo fork Papr-ai/paprwork-community-apps --clone --remote -- /tmp/paprwork-community-apps 2) cp -r ${bundlePath} /tmp/paprwork-community-apps/bundles/${bundleId} 3) Use the "registryEntry" JSON from this result — just fill in "author" (run "gh api user -q .login") and "tags", then append it to the bundles array in /tmp/paprwork-community-apps/registry.json (do NOT modify existing entries). The registryEntry already has the correct types for requirements (string[]) and platform (string[]) — do NOT flatten these to bare strings. 4) cd /tmp/paprwork-community-apps && git checkout -b add-${bundleId} && git add . && git commit -m "Add ${args.name}" && git push -u origin add-${bundleId} 5) gh pr create --repo Papr-ai/paprwork-community-apps --title "Add ${args.name}" --body "New community app"`,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const apiKeys = getApiKeysForSanitization();
      throw new Error(
        JSON.stringify({
          success: false,
          error: sanitizeError((error as Error).message, apiKeys),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

export const importAppBundleTool = createTool({
  id: "import_app_bundle",
  description: `Import an app bundle from a local path or GitHub URL.
Validates manifest, checks for conflicts, and installs the complete app with all jobs and database schemas.

Supports:
- Local paths: ~/Downloads/my-app-bundle
- GitHub URLs: github.com/user/repo or https://github.com/user/repo
- Community repo with subPath: source="github.com/Papr-ai/paprwork-community-apps" subPath="bundles/meetings-manager"

Use subPath when the bundle is inside a subdirectory of the repo (e.g., the Paprwork community apps repo).
If app/job IDs conflict with existing ones, generates new UUIDs when renameConflicts is true. All references (source files, data-sources.json, job dependencies) are updated automatically.

After import, check the result for:
- requirements: API keys the app needs (configure in Settings → Custom Keys)
- platform: which OS the app supports
- pythonJobs: Python jobs that will auto-create venvs on first run`,
  inputSchema: importAppBundleSchema,
  execute: async (input) => {
    const args = (input as { context?: ImportAppBundleArgs }).context ?? input;
    const startTime = performance.now();

    try {
      const { getBundleService } =
        await import("../../gateway/services/BundleService.js");
      const osModule = await import("os");
      const pathModule = await import("path");
      const fsModule = await import("fs/promises");
      const bundleService = getBundleService();
      await bundleService.initialize();

      let sourcePath = args.source;
      let gitCloneDir: string | undefined;

      if (
        args.source.startsWith("github.com/") ||
        args.source.startsWith("https://github.com/") ||
        args.source.includes("github.com")
      ) {
        let gitUrl = args.source;
        if (!gitUrl.startsWith("http")) {
          gitUrl = `https://${gitUrl}`;
        }
        if (!gitUrl.endsWith(".git")) {
          gitUrl = `${gitUrl}.git`;
        }

        gitCloneDir = pathModule.default.join(
          osModule.default.tmpdir(),
          `papr-app-bundle-${Date.now()}`,
        );
        await fsModule.mkdir(gitCloneDir, { recursive: true });

        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        const { getShell } = await import("../utils/platform.js");

        try {
          await execAsync(`git clone --depth 1 ${gitUrl} ${gitCloneDir}`, {
            timeout: 120000,
            shell: getShell(),
          });
        } catch (error) {
          throw new Error(
            `Failed to clone repository: ${(error as Error).message}`,
          );
        }

        sourcePath = args.subPath
          ? pathModule.default.join(gitCloneDir, args.subPath)
          : gitCloneDir;
      } else {
        sourcePath = sourcePath.replace(/^~/, osModule.default.homedir());
        if (args.subPath) {
          sourcePath = pathModule.default.join(sourcePath, args.subPath);
        }
      }

      const manifestPath = pathModule.default.join(sourcePath, "manifest.json");
      const manifestRaw = await fsModule.readFile(manifestPath, "utf8");
      const { parseBundleManifest } =
        await import("../../core/types/bundles.js");
      const manifest = parseBundleManifest(JSON.parse(manifestRaw));

      const { getAppService } =
        await import("../../gateway/services/AppService.js");
      const { getJobsService } =
        await import("../../gateway/services/JobsService.js");
      const appService = getAppService();
      const jobsService = getJobsService();
      await appService.initialize();
      await jobsService.initialize();

      const conflicts: string[] = [];
      const idRemaps = new Map<string, string>();
      const existingApp = await appService.getApp(manifest.app.id);
      if (existingApp) {
        conflicts.push(
          `App "${manifest.app.name}" (${manifest.app.id}) already exists`,
        );
      }

      for (const jobSpec of manifest.jobs) {
        const existingJob = await jobsService.getJob(jobSpec.id);
        if (existingJob) {
          conflicts.push(
            `Job "${jobSpec.name}" (${jobSpec.id}) already exists`,
          );
        }
      }

      if (conflicts.length > 0 && !args.renameConflicts) {
        throw new Error(
          `Import blocked due to conflicts: ${conflicts.join(", ")}. Set renameConflicts: true to import anyway.`,
        );
      }

      if (conflicts.length > 0 && args.renameConflicts) {
        const { randomUUID } = await import("node:crypto");
        if (existingApp) {
          idRemaps.set(manifest.app.id, randomUUID());
        }
        for (const jobSpec of manifest.jobs) {
          const existingJob = await jobsService.getJob(jobSpec.id);
          if (existingJob) {
            idRemaps.set(jobSpec.id, randomUUID());
          }
        }
      }

      const result = await bundleService.importBundle({
        sourcePath,
        idRemaps: idRemaps.size > 0 ? idRemaps : undefined,
      });

      if (gitCloneDir) {
        await fsModule.rm(gitCloneDir, { recursive: true, force: true });
      }

      const requirements = result.requirements ?? [];
      const platform = result.platform ?? [];

      const userPlatform =
        process.platform === "darwin"
          ? "macos"
          : process.platform === "win32"
            ? "windows"
            : "linux";
      const platformWarning =
        platform.length > 0 && !platform.includes(userPlatform)
          ? `WARNING: This bundle targets ${platform.join(", ")} but you are on ${userPlatform}. Some features may not work.`
          : undefined;

      // --- Post-import validation ---
      const validationIssues: string[] = [];
      const postImportSteps: string[] = [];

      const appDir = await appService.getAppPath(result.app.id);
      if (appDir) {
        try {
          await fsModule.access(
            pathModule.default.join(appDir, "index.html"),
          );
        } catch {
          validationIssues.push(
            `App missing index.html — the app may not load correctly`,
          );
        }
      }

      for (const jobSpec of result.jobs) {
        if (
          jobSpec.type !== "agent" &&
          (!jobSpec.command || jobSpec.command.trim() === "")
        ) {
          validationIssues.push(
            `Job "${jobSpec.name}" has no command — it will fail when run`,
          );
        }
      }

      if (requirements.length > 0) {
        postImportSteps.push(
          `Configure required API keys in Settings → Custom Keys: ${requirements.join(", ")}`,
        );
      }

      // Report dependency setup results (venvs, npm install — already ran during import)
      const setupResults = result.setupResults ?? [];
      const setupFailures = setupResults.filter((r) => !r.ok);
      const setupSuccesses = setupResults.filter((r) => r.ok);
      if (setupSuccesses.length > 0) {
        postImportSteps.push(
          `Dependencies installed: ${setupSuccesses.map((r) => r.message).join("; ")}`,
        );
      }
      if (setupFailures.length > 0) {
        for (const failure of setupFailures) {
          validationIssues.push(failure.message);
        }
      }

      const scheduledJobs = result.jobs.filter(
        (j) => j.schedule && typeof j.schedule === "object",
      );
      if (scheduledJobs.length > 0) {
        postImportSteps.push(
          `Scheduled jobs imported: ${scheduledJobs.map((j) => j.name).join(", ")}. Verify schedules are correct before enabling.`,
        );
      }

      return {
        success: true,
        data: {
          bundleId: result.bundleId,
          appId: result.app.id,
          appName: result.app.name,
          jobIds: result.jobs.map((j) => j.id),
          jobSummary: result.jobs.map((j) => ({
            id: j.id,
            name: j.name,
            type: j.type,
            command: j.command,
            hasSchedule: !!j.schedule,
          })),
          requirements,
          platform,
          platformWarning,
          postImportSteps,
          validationIssues:
            validationIssues.length > 0 ? validationIssues : undefined,
          warnings:
            conflicts.length > 0 && idRemaps.size > 0
              ? `Conflicts resolved: ${[...idRemaps.entries()].map(([old, nw]) => `${old} → ${nw}`).join(", ")}`
              : conflicts.length > 0
                ? `Conflicts detected but no remapping needed.`
                : undefined,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const apiKeys = getApiKeysForSanitization();
      throw new Error(
        JSON.stringify({
          success: false,
          error: sanitizeError((error as Error).message, apiKeys),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

export const listAppBundlesTool = createTool({
  id: "list_app_bundles",
  description: `List all installed app bundles in ~/Papr/bundles/.
Shows bundle ID, name, version, path, and creation date for each shareable app.`,
  inputSchema: z.object({}),
  execute: async () => {
    const startTime = performance.now();

    try {
      const { getBundleService } =
        await import("../../gateway/services/BundleService.js");
      const bundleService = getBundleService();
      await bundleService.initialize();

      const bundles = await bundleService.listBundles();

      return {
        success: true,
        data: {
          total: bundles.length,
          bundles,
          tip: "Use get_app_bundle_info({ source: bundleId }) to preview an app bundle's contents.",
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const apiKeys = getApiKeysForSanitization();
      throw new Error(
        JSON.stringify({
          success: false,
          error: sanitizeError((error as Error).message, apiKeys),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

export const getAppBundleInfoTool = createTool({
  id: "get_app_bundle_info",
  description: `Preview an app bundle's contents without importing it.
Reads and parses the manifest.json to show app info, job specs, and database schemas.
Use this to inspect an app bundle before deciding to import it.`,
  inputSchema: getAppBundleInfoSchema,
  execute: async (input) => {
    const args = (input as { context?: GetAppBundleInfoArgs }).context ?? input;
    const startTime = performance.now();

    try {
      const osModule = await import("os");
      const pathModule = await import("path");
      const fsModule = await import("fs/promises");

      let sourcePath = args.source;
      if (!sourcePath.includes("/")) {
        sourcePath = pathModule.default.join(
          osModule.default.homedir(),
          "Papr",
          "bundles",
          sourcePath,
        );
      } else {
        sourcePath = sourcePath.replace(/^~/, osModule.default.homedir());
      }

      const manifestPath = pathModule.default.join(sourcePath, "manifest.json");
      const manifestRaw = await fsModule.readFile(manifestPath, "utf8");
      const { parseBundleManifest } =
        await import("../../core/types/bundles.js");
      const manifest = parseBundleManifest(JSON.parse(manifestRaw));

      return {
        success: true,
        data: {
          bundleId: manifest.bundleId,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          minPaprworkVersion: manifest.minPaprworkVersion,
          app: {
            id: manifest.app.id,
            name: manifest.app.name,
            description: manifest.app.description,
          },
          jobs: manifest.jobs.map((j) => ({
            id: j.id,
            name: j.name,
            type: j.type,
            command: j.command,
            dependsOn: j.dependsOn,
          })),
          databases: manifest.sqlite.map((db) => ({
            id: db.id,
            tables: db.tables.length,
            tableNames: db.tables.map((t) => t.name),
          })),
          createdAt: manifest.createdAt,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const apiKeys = getApiKeysForSanitization();
      throw new Error(
        JSON.stringify({
          success: false,
          error: sanitizeError((error as Error).message, apiKeys),
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

// ===== File version history tools =====

const appFileVersionsSchema = toolSchemaWithFilenameAlias(
  z.object({
    appId: z.string().min(1).describe("App UUID"),
    filename: z.string().min(1).describe("Filename to get version history for"),
  }),
);

const appFileVersionSchema = toolSchemaWithFilenameAlias(
  z.object({
    appId: z.string().min(1).describe("App UUID"),
    filename: z.string().min(1).describe("Filename"),
    versionId: z.string().min(1).describe("Version ID from list_app_file_versions"),
  }),
);

const restoreAppFileVersionSchema = toolSchemaWithFilenameAlias(
  z.object({
    appId: z.string().min(1).describe("App UUID"),
    filename: z.string().min(1).describe("Filename to restore"),
    versionId: z.string().min(1).describe("Version ID to restore to"),
  }),
);

const jobFileVersionsSchema = toolSchemaWithFilenameAlias(
  z.object({
    jobId: z.string().min(1).describe("Job UUID"),
    filename: z.string().min(1).describe("Filename to get version history for"),
  }),
);

const jobFileVersionSchema = toolSchemaWithFilenameAlias(
  z.object({
    jobId: z.string().min(1).describe("Job UUID"),
    filename: z.string().min(1).describe("Filename"),
    versionId: z.string().min(1).describe("Version ID from list_job_file_versions"),
  }),
);

const restoreJobFileVersionSchema = toolSchemaWithFilenameAlias(
  z.object({
    jobId: z.string().min(1).describe("Job UUID"),
    filename: z.string().min(1).describe("Filename to restore"),
    versionId: z.string().min(1).describe("Version ID to restore to"),
  }),
);

type AppFileVersionsArgs = z.infer<typeof appFileVersionsSchema>;
type AppFileVersionArgs = z.infer<typeof appFileVersionSchema>;
type RestoreAppFileVersionArgs = z.infer<typeof restoreAppFileVersionSchema>;
type JobFileVersionsArgs = z.infer<typeof jobFileVersionsSchema>;
type JobFileVersionArgs = z.infer<typeof jobFileVersionSchema>;
type RestoreJobFileVersionArgs = z.infer<typeof restoreJobFileVersionSchema>;

export const listAppFileVersionsTool = createTool({
  id: "list_app_file_versions",
  description: `List all saved versions of a mini-app file (newest first).
Every time a file is edited, the previous content is automatically saved.
Use this to see what changed and when, or to find a version to restore.`,
  inputSchema: appFileVersionsSchema,
  execute: async (input) => {
    const args = (input as { context?: AppFileVersionsArgs }).context ?? input;
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();
    const versions = await appService.getFileVersionHistory(args.appId, args.filename);
    return {
      success: true,
      data: {
        appId: args.appId,
        filename: args.filename,
        versions,
        count: versions.length,
        tip: versions.length > 0
          ? "Use get_app_file_version to see full content, or restore_app_file_version to revert."
          : "No versions yet. Versions are created automatically when the file is edited.",
      },
    };
  },
});

export const getAppFileVersionTool = createTool({
  id: "get_app_file_version",
  description: "Get the full content of a specific saved version of a mini-app file",
  inputSchema: appFileVersionSchema,
  execute: async (input) => {
    const args = (input as { context?: AppFileVersionArgs }).context ?? input;
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();
    const version = await appService.getFileVersion(args.appId, args.filename, args.versionId);
    if (!version) {
      throw new Error(`Version not found: ${args.versionId} for ${args.filename} in app ${args.appId}`);
    }
    return { success: true, data: version };
  },
});

export const restoreAppFileVersionTool = createTool({
  id: "restore_app_file_version",
  description: `Restore a mini-app file to a previous version. The current content is saved as a "before-restore" version first (so you can undo the restore if needed).
Use list_app_file_versions first to find the versionId.`,
  inputSchema: restoreAppFileVersionSchema,
  execute: async (input) => {
    const args = (input as { context?: RestoreAppFileVersionArgs }).context ?? input;
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();
    const restored = await appService.restoreFileVersion(args.appId, args.filename, args.versionId);
    if (!restored) {
      throw new Error(`Failed to restore: version ${args.versionId} not found for ${args.filename} in app ${args.appId}`);
    }
    return {
      success: true,
      data: {
        appId: args.appId,
        filename: args.filename,
        restoredVersionId: args.versionId,
        tip: "Current content was saved as 'before-restore' version. Use list_app_file_versions to see it.",
      },
    };
  },
});

export const listJobFileVersionsTool = createTool({
  id: "list_job_file_versions",
  description: `List all saved versions of a job file (newest first).
Every time a job file is edited, the previous content is automatically saved.
Use this to see what changed and when, or to find a version to restore.`,
  inputSchema: jobFileVersionsSchema,
  execute: async (input) => {
    const args = (input as { context?: JobFileVersionsArgs }).context ?? input;
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const versions = await jobsService.getJobFileVersionHistory(args.jobId, args.filename);
    return {
      success: true,
      data: {
        jobId: args.jobId,
        filename: args.filename,
        versions,
        count: versions.length,
        tip: versions.length > 0
          ? "Use get_job_file_version to see full content, or restore_job_file_version to revert."
          : "No versions yet. Versions are created automatically when the file is edited.",
      },
    };
  },
});

export const getJobFileVersionTool = createTool({
  id: "get_job_file_version",
  description: "Get the full content of a specific saved version of a job file",
  inputSchema: jobFileVersionSchema,
  execute: async (input) => {
    const args = (input as { context?: JobFileVersionArgs }).context ?? input;
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const version = await jobsService.getJobFileVersion(args.jobId, args.filename, args.versionId);
    if (!version) {
      throw new Error(`Version not found: ${args.versionId} for ${args.filename} in job ${args.jobId}`);
    }
    return { success: true, data: version };
  },
});

export const restoreJobFileVersionTool = createTool({
  id: "restore_job_file_version",
  description: `Restore a job file to a previous version. The current content is saved as a "before-restore" version first (so you can undo the restore if needed).
Use list_job_file_versions first to find the versionId.`,
  inputSchema: restoreJobFileVersionSchema,
  execute: async (input) => {
    const args = (input as { context?: RestoreJobFileVersionArgs }).context ?? input;
    const { getJobsService } =
      await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const restored = await jobsService.restoreJobFileVersion(args.jobId, args.filename, args.versionId);
    if (!restored) {
      throw new Error(`Failed to restore: version ${args.versionId} not found for ${args.filename} in job ${args.jobId}`);
    }
    return {
      success: true,
      data: {
        jobId: args.jobId,
        filename: args.filename,
        restoredVersionId: args.versionId,
        tip: "Current content was saved as 'before-restore' version. Use list_job_file_versions to see it.",
      },
    };
  },
});

// ==================== MINI-APP VALIDATION ====================

const validateAppSchema = z.object({
  appId: z.string().describe("The ID of the mini-app to validate"),
});

type ValidateAppArgs = z.infer<typeof validateAppSchema>;

export const validateAppTool = createTool({
  id: "validate_app",
  description: `Validate a mini-app for code quality issues and enforcement rules.
Checks:
- **100-line limit per file** (enforced): Files must be ≤100 significant lines. Break large files into components.
- **HTML syntax**: Unclosed tags, malformed markup
- **CSS syntax**: Mismatched braces, double semicolons
- **JavaScript/TypeScript syntax**: Mismatched delimiters (braces, parens, brackets)
- **Code quality**: console.log statements (should be removed)

Returns validation result with list of issues (errors and warnings).
IMPORTANT: Run this after creating/editing app files to catch issues early!`,
  inputSchema: validateAppSchema,
  execute: async (input) => {
    const args = (input as { context?: ValidateAppArgs }).context ?? input;
    const { getAppService } =
      await import("../../gateway/services/AppService.js");
    const appService = getAppService();
    await appService.initialize();
    
    const result = await appService.validateApp(args.appId);
    
    if (!result.valid) {
      const errorCount = result.issues.filter(i => i.severity === 'error').length;
      const warningCount = result.issues.filter(i => i.severity === 'warning').length;
      
      const issueList = result.issues.map(issue => 
        `- ${issue.severity === 'error' ? '❌' : '⚠️'} ${issue.file}: ${issue.message}`
      ).join('\n');

      return {
        success: false,
        error: [
          `⛔ VALIDATION FAILED — ${errorCount} error(s), ${warningCount} warning(s). You MUST fix these before proceeding.`,
          '',
          issueList,
          '',
          errorCount > 0
            ? 'ACTION REQUIRED: Fix all ❌ errors now. For files over the 100-line limit, extract code into smaller component files (components/, utils/, types.ts). Do NOT continue with other work until errors are resolved.'
            : 'Warnings found. Fix if possible before proceeding.',
        ].join('\n'),
        data: {
          valid: false,
          filesChecked: result.filesChecked,
          issues: result.issues.map(issue => ({
            file: issue.file,
            line: issue.line,
            severity: issue.severity,
            message: issue.message,
            rule: issue.rule,
          })),
          summary: `${errorCount} error(s), ${warningCount} warning(s)`,
        },
      };
    }
    
    return {
      success: true,
      data: {
        valid: true,
        filesChecked: result.filesChecked,
        message: `✓ All ${result.filesChecked} files passed validation`,
        nextStep:
          "webview_launch_app → page_wait_for({ target: 'mini_app', time: 2 }) or webview_snapshot",
      },
    };
  },
});

const getJobHistorySchema = z.object({
  jobId: z.string().min(1).describe("Job ID to get run history for"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of runs to return (default: 20)"),
});

const getJobStatsSchema = z.object({
  jobId: z.string().min(1).describe("Job ID to get statistics for"),
});

type GetJobHistoryArgs = z.infer<typeof getJobHistorySchema>;
type GetJobStatsArgs = z.infer<typeof getJobStatsSchema>;

export const getJobHistoryTool = createTool({
  id: "get_job_history",
  description:
    "Get run history for a job (last N runs with status, duration, timestamps). Use this to debug patterns: 'why did this fail 5 times yesterday?', 'how long do runs typically take?', 'when did this last succeed?'",
  inputSchema: getJobHistorySchema,
  execute: async (input) => {
    const args = (input as { context?: GetJobHistoryArgs }).context ?? input;
    const { getJobRunHistory } =
      await import("../../gateway/services/jobs/JobRunHistory.js");
    const runHistory = getJobRunHistory();
    await runHistory.initialize();

    const runs = await runHistory.getRunsForJob(args.jobId, args.limit ?? 20);

    return {
      success: true,
      data: {
        jobId: args.jobId,
        totalReturned: runs.length,
        runs: runs.map((r) => ({
          runId: r.runId,
          status: r.status,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          duration: r.duration ? `${Math.round(r.duration / 1000)}s` : undefined,
          exitCode: r.exitCode,
          error: r.error ? r.error.slice(0, 200) : undefined, // Truncate long errors
          scheduledDueAt: r.scheduledDueAt,
          attempt: r.attempt,
          maxAttempts: r.maxAttempts,
        })),
      },
    };
  },
});

export const getJobStatsTool = createTool({
  id: "get_job_stats",
  description:
    "Get statistics for a job (total runs, success/failure counts, average duration). Use this to assess job reliability and performance.",
  inputSchema: getJobStatsSchema,
  execute: async (input) => {
    const args = (input as { context?: GetJobStatsArgs }).context ?? input;
    const { getJobRunHistory } =
      await import("../../gateway/services/jobs/JobRunHistory.js");
    const runHistory = getJobRunHistory();
    await runHistory.initialize();

    const stats = await runHistory.getStats(args.jobId);

    return {
      success: true,
      data: {
        jobId: args.jobId,
        totalRuns: stats.totalRuns,
        completedRuns: stats.completedRuns,
        failedRuns: stats.failedRuns,
        cancelledRuns: stats.cancelledRuns,
        successRate:
          stats.totalRuns > 0
            ? `${Math.round((stats.completedRuns / stats.totalRuns) * 100)}%`
            : "N/A",
        avgDuration: stats.avgDuration
          ? `${Math.round(stats.avgDuration / 1000)}s`
          : "N/A",
        lastRunAt: stats.lastRunAt,
      },
    };
  },
});

export const reloadJobsTool = createTool({
  id: "reload_jobs",
  description: `Reload jobs from disk after manually editing jobs.json.

Use when:
- You manually edited jobs.json via bash/jq commands
- You want to verify changes without restarting the app

NOT needed for:
- Stuck jobs → Process-backed jobs auto-recover in 20-60s
- Agent jobs stuck → Fixed automatically on next app restart
- Normal job operations → use update_job(), run_job() instead`,
  inputSchema: z.object({}),
  execute: async () => {
    const startTime = performance.now();

    try {
      const { getJobsService } = await import("../../gateway/services/JobsService.js");
      const jobsService = getJobsService();
      await jobsService.reloadJobs();
      const jobs = await jobsService.listJobs();

      return {
        success: true,
        data: {
          reloaded: true,
          jobsCount: jobs.length,
          message: `Successfully reloaded ${jobs.length} jobs from disk. Scheduler state updated.`,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  },
});

export const appJobsTools = [
  createAppTool,
  deleteAppTool,
  createJobTool,
  runJobTool,
  readJobLogsTool,
  listJobsTool,
  listJobFilesTool,
  readJobFileTool,
  editJobFileTool,
  updateJobTool,
  deleteJobTool,
  getJobHistoryTool,
  getJobStatsTool,
  reloadJobsTool,
  linkAppDataSourceTool,
  readAppDataSourcesTool,
  readAppFileTool,
  editAppFileTool,
  editAppFileLinesTool,
  listAppFilesTool,
  listAppsTool,
  validateAppTool,
  exportAppBundleTool,
  importAppBundleTool,
  listAppBundlesTool,
  getAppBundleInfoTool,
  listAppFileVersionsTool,
  getAppFileVersionTool,
  restoreAppFileVersionTool,
  listJobFileVersionsTool,
  getJobFileVersionTool,
  restoreJobFileVersionTool,
];
