/**
 * WorkspaceService - Manages agent workspace files for persistent context
 *
 * Workspace files live in ~/PAPR/workspace/ and are injected into the system
 * prompt on every agent turn. The agent reads and writes these files using
 * existing tools (write_file, bash) to improve itself over time.
 *
 * Inspired by OpenClaw's bootstrap file injection pattern.
 *
 * Files:
 *   MEMORY.md    - Long-term curated memory (decisions, preferences, patterns)
 *   IDENTITY.md  - User profile (name, role, tone, goals)
 *   AGENTS.md    - Operating contract (workflow rules, boundaries)
 *   TOOLS.md     - Environment notes (CLIs, APIs, paths)
 *   ONBOARD.md   - First-run interview script (deleted after completion)
 *   memory/YYYY-MM-DD.md - Daily working logs (append-only)
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Maximum characters per injected workspace file */
const MAX_CHARS_PER_FILE = 20_000;

/** Maximum total characters across all injected workspace content */
const MAX_TOTAL_CHARS = 80_000;

/** Workspace files to inject (in order of priority) */
const WORKSPACE_FILES = [
  "IDENTITY.md",
  "MEMORY.md",
  "AGENTS.md",
  "TOOLS.md",
] as const;

/** A loaded workspace file with truncation metadata */
export interface WorkspaceFile {
  name: string;
  content: string;
  truncated: boolean;
  rawLength: number;
}

/** Full workspace context ready for system prompt injection */
export interface WorkspaceContext {
  files: WorkspaceFile[];
  dailyLogs: WorkspaceFile[];
  onboardingPending: boolean;
  onboardContent: string | null;
  totalChars: number;
}

export class WorkspaceService {
  private workspaceDir: string;
  private memoryDir: string;
  private initialized = false;

  constructor() {
    const homeDir = os.homedir();
    this.workspaceDir = path.join(homeDir, "PAPR", "workspace");
    this.memoryDir = path.join(this.workspaceDir, "memory");
  }

  /** Get the workspace directory path */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  /**
   * Initialize workspace directory with template files on first run.
   * Safe to call multiple times (idempotent).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create workspace directory structure
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await fs.mkdir(this.memoryDir, { recursive: true });
    await fs.mkdir(path.join(this.memoryDir, "archive"), { recursive: true });

    // Copy template files if they don't exist yet
    const templatesDir = this.resolveTemplatesDir();
    const templateFiles = [
      "MEMORY.md",
      "IDENTITY.md",
      "AGENTS.md",
      "TOOLS.md",
      "ONBOARD.md",
      "SLEEP.md",
    ];

    for (const filename of templateFiles) {
      const destPath = path.join(this.workspaceDir, filename);
      const exists = await this.fileExists(destPath);
      if (!exists) {
        const srcPath = path.join(templatesDir, filename);
        const srcExists = await this.fileExists(srcPath);
        if (srcExists) {
          const content = await fs.readFile(srcPath, "utf8");
          await fs.writeFile(destPath, content, "utf8");
          console.log(`[WorkspaceService] Created template: ${filename}`);
        } else {
          // Fallback: create minimal placeholder
          await fs.writeFile(destPath, `# ${filename.replace(".md", "")}\n\n`, "utf8");
          console.log(`[WorkspaceService] Created placeholder: ${filename}`);
        }
      }
    }

    this.initialized = true;
    console.log(`[WorkspaceService] Workspace initialized at ${this.workspaceDir}`);
  }

  /**
   * Load all workspace files for system prompt injection.
   * Applies per-file and total truncation limits.
   */
  async loadWorkspaceContext(): Promise<WorkspaceContext> {
    const files: WorkspaceFile[] = [];
    let totalChars = 0;

    // Load core workspace files (in priority order)
    for (const filename of WORKSPACE_FILES) {
      if (totalChars >= MAX_TOTAL_CHARS) break;

      const filePath = path.join(this.workspaceDir, filename);
      const loaded = await this.loadAndTruncate(filePath, filename, MAX_TOTAL_CHARS - totalChars);
      if (loaded) {
        files.push(loaded);
        totalChars += loaded.content.length;
      }
    }

    // Load daily logs (today + yesterday)
    const dailyLogs = await this.loadDailyLogs(MAX_TOTAL_CHARS - totalChars);
    for (const log of dailyLogs) {
      totalChars += log.content.length;
    }

    // Check onboarding status
    const onboardPath = path.join(this.workspaceDir, "ONBOARD.md");
    const onboardCompletedPath = path.join(this.workspaceDir, "ONBOARD.completed.md");
    const onboardExists = await this.fileExists(onboardPath);
    const onboardCompleted = await this.fileExists(onboardCompletedPath);
    const onboardingPending = onboardExists && !onboardCompleted;

    let onboardContent: string | null = null;
    if (onboardingPending) {
      try {
        onboardContent = await fs.readFile(onboardPath, "utf8");
        if (onboardContent.length > MAX_CHARS_PER_FILE) {
          onboardContent = onboardContent.substring(0, MAX_CHARS_PER_FILE)
            + "\n\n[... truncated at 20,000 chars ...]";
        }
      } catch {
        // File read error — skip onboarding content
      }
    }

    return {
      files,
      dailyLogs,
      onboardingPending,
      onboardContent,
      totalChars,
    };
  }

  /**
   * Check if onboarding has been completed.
   */
  async isOnboardingComplete(): Promise<boolean> {
    const onboardPath = path.join(this.workspaceDir, "ONBOARD.md");
    const completedPath = path.join(this.workspaceDir, "ONBOARD.completed.md");

    const onboardExists = await this.fileExists(onboardPath);
    const completedExists = await this.fileExists(completedPath);

    // Complete if: ONBOARD.md doesn't exist, OR ONBOARD.completed.md exists
    return !onboardExists || completedExists;
  }

  // ——— Private helpers ———

  /**
   * Load today's and yesterday's daily memory logs.
   */
  private async loadDailyLogs(remainingBudget: number): Promise<WorkspaceFile[]> {
    const logs: WorkspaceFile[] = [];
    let budget = remainingBudget;

    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const dates = [
      { date: yesterday, label: "yesterday" },
      { date: today, label: "today" },
    ];

    for (const { date, label } of dates) {
      if (budget <= 0) break;

      const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
      const filename = `${dateStr}.md`;
      const filePath = path.join(this.memoryDir, filename);
      const loaded = await this.loadAndTruncate(filePath, `memory/${filename} (${label})`, budget);
      if (loaded) {
        logs.push(loaded);
        budget -= loaded.content.length;
      }
    }

    return logs;
  }

  /**
   * Load a file and truncate to fit within limits.
   */
  private async loadAndTruncate(
    filePath: string,
    displayName: string,
    remainingBudget: number,
  ): Promise<WorkspaceFile | null> {
    try {
      const exists = await this.fileExists(filePath);
      if (!exists) return null;

      const raw = await fs.readFile(filePath, "utf8");
      if (raw.trim().length === 0) return null;

      const maxChars = Math.min(MAX_CHARS_PER_FILE, remainingBudget);
      let content = raw;
      let truncated = false;

      if (content.length > maxChars) {
        content = content.substring(0, maxChars) + "\n\n[... truncated at 20,000 chars ...]";
        truncated = true;
      }

      return {
        name: displayName,
        content,
        truncated,
        rawLength: raw.length,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolve the path to bundled workspace templates.
   * Handles both dev (src/resources/) and production (dist/) layouts.
   */
  private resolveTemplatesDir(): string {
    // Try relative to this file first (gateway/services/ -> ../../resources/)
    const candidates = [
      path.resolve(__dirname, "../../resources/workspace-templates"),
      path.resolve(__dirname, "../../../src/resources/workspace-templates"),
      path.resolve(process.cwd(), "src/resources/workspace-templates"),
    ];

    // Return first candidate — we'll check file existence when copying
    return candidates[0];
  }

  /**
   * Check if a file exists without throwing.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure the built-in "papr-sleep" agent job exists.
   * This job runs daily at 7pm to review daily logs and distill learnings
   * into workspace files, bridging local context with Papr Memory.
   */
  async ensureSleepJob(): Promise<void> {
    try {
      const { getJobsService } = await import("./JobsService.js");
      const jobsService = getJobsService();
      const allJobs = await jobsService.listJobs();

      const sleepJobExists = allJobs.some(
        (j) => j.name === "papr-sleep" || j.name === "Papr Sleep Cycle",
      );

      if (sleepJobExists) {
        console.log("[WorkspaceService] Sleep job already exists");
        return;
      }

      // Read the sleep prompt from the workspace SLEEP.md (user/agent-customisable)
      const sleepMdPath = path.join(this.workspaceDir, "SLEEP.md");
      let sleepPrompt: string;
      try {
        sleepPrompt = await fs.readFile(sleepMdPath, "utf8");
      } catch {
        // Fallback if SLEEP.md is missing for some reason
        sleepPrompt = "Review daily logs in ~/PAPR/workspace/memory/, distill learnings into MEMORY.md/IDENTITY.md/AGENTS.md/TOOLS.md, archive logs older than 14 days.";
      }

      const job = await jobsService.createJob({
        name: "Papr Sleep Cycle",
        type: "agent",
        command: sleepPrompt,
        schedule: {
          enabled: true,
          cron: "0 19 * * *", // Daily at 7pm local time
        },
        memoryPolicy: "summary",
        maxTurns: 20,
      });

      // Write task.md alongside job.json for user visibility and customisation
      const jobDir = await jobsService.getJobPath(job.id);
      if (jobDir) {
        await fs.writeFile(
          path.join(jobDir, "task.md"),
          sleepPrompt,
          "utf8",
        );
      }

      console.log("[WorkspaceService] Created papr-sleep agent job (daily at 7pm)");
    } catch (error) {
      console.warn("[WorkspaceService] Failed to create sleep job:", error);
      // Non-fatal: workspace still works without the sleep job
    }
  }
}

// Singleton
let workspaceServiceInstance: WorkspaceService | null = null;

export function getWorkspaceService(): WorkspaceService {
  if (!workspaceServiceInstance) {
    workspaceServiceInstance = new WorkspaceService();
  }
  return workspaceServiceInstance;
}

export async function initializeWorkspaceService(): Promise<WorkspaceService> {
  const service = getWorkspaceService();
  await service.initialize();
  return service;
}
