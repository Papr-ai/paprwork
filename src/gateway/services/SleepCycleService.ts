/**
 * SleepCycleService — built-in daily sleep job sync + preflight context
 *
 * Ensures exactly one "Papr Sleep Cycle" agent job exists, keeps config current,
 * and builds preloaded context (chat summaries, jobs, bootstrap memory) for each run.
 */

import { promises as fs } from "fs";
import { getPaprWorkspaceDir } from "../../core/utils/paprRoot.js";
import path from "path";
import { fileURLToPath } from "url";
import type { JobRecord } from "./jobs/types.js";
import { STANDALONE_APP_ID } from "./jobs/appIds.js";
import {
  formatJobArchitectureErrors,
  validateJobArchitecture,
} from "./jobs/jobArchitectureValidation.js";
import { normalizePortableJobPrompt } from "./jobs/normalizePortableJobPrompt.js";
import type { ChatSummarySnapshot } from "./storage/IStorageProvider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SLEEP_JOB_NAMES = ["Papr Sleep Cycle", "papr-sleep"] as const;
export const SLEEP_PROMPT_VERSION = 12;

export const SLEEP_JOB_DEFAULTS = {
  provider: "anthropic" as const,
  model: "claude-sonnet-5",
  maxTurns: 100,
  memoryPolicy: "none" as const,
  schedule: {
    enabled: true,
    cron: "0 19 * * *",
  },
  retries: {
    maxAttempts: 2,
    backoffMs: 5000,
  },
};

export function isSleepCycleJobName(name: string): boolean {
  return (SLEEP_JOB_NAMES as readonly string[]).includes(name);
}

function resolveTemplatesDir(): string {
  const candidates = [
    path.resolve(__dirname, "../../resources/workspace-templates"),
    path.resolve(__dirname, "../../../src/resources/workspace-templates"),
    path.resolve(process.cwd(), "src/resources/workspace-templates"),
  ];
  return candidates[0];
}

function workspaceDir(): string {
  return getPaprWorkspaceDir();
}

function sleepPromptVersion(content: string): number {
  const match = content.match(/sleep-prompt-version:\s*(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readSleepPrompt(): Promise<string> {
  const templatesDir = resolveTemplatesDir();
  const templatePath = path.join(templatesDir, "SLEEP.md");
  const workspacePath = path.join(workspaceDir(), "SLEEP.md");

  let templateContent = "";
  if (await fileExists(templatePath)) {
    templateContent = await fs.readFile(templatePath, "utf8");
  }

  const workspaceExists = await fileExists(workspacePath);
  if (!workspaceExists && templateContent) {
    await fs.writeFile(workspacePath, templateContent, "utf8");
    return normalizePortableJobPrompt(templateContent);
  }

  if (workspaceExists) {
    const workspaceContent = await fs.readFile(workspacePath, "utf8");
    const wsVersion = sleepPromptVersion(workspaceContent);
    const tplVersion = templateContent
      ? sleepPromptVersion(templateContent)
      : 0;

    if (tplVersion > wsVersion && templateContent) {
      await fs.writeFile(workspacePath, templateContent, "utf8");
      console.log(
        `[SleepCycleService] Upgraded SLEEP.md v${wsVersion} → v${tplVersion}`,
      );
      return normalizePortableJobPrompt(templateContent);
    }
    return normalizePortableJobPrompt(workspaceContent);
  }

  return (
    normalizePortableJobPrompt(
      templateContent ||
        "Review recent chats and jobs, distill learnings into $PAPR_HOME/workspace/*.md",
    )
  );
}

function pickKeeperJob(jobs: JobRecord[]): JobRecord {
  return [...jobs].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )[0];
}

function formatChatSummaries(snapshots: ChatSummarySnapshot[]): string {
  if (snapshots.length === 0) {
    return "_No chat summaries in the last 7 days (run chats with Papr Memory sync for summaries)._";
  }

  return snapshots
    .map((s) => {
      const topics =
        s.summary_topics.length > 0
          ? `\n  Topics: ${s.summary_topics.slice(0, 8).join(", ")}`
          : "";
      const short = s.summary_short?.trim() ?? "";
      const medium = s.summary_medium?.trim() ?? "";
      const body = medium || short || "(empty summary)";
      return `- **${s.title}** (${s.updated_at}, ${s.message_count} msgs)${topics}\n  ${body.slice(0, 800)}`;
    })
    .join("\n\n");
}

function formatRecentJobs(jobs: JobRecord[], sleepJobId: string): string {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = jobs
    .filter((j) => j.id !== sleepJobId && !isSleepCycleJobName(j.name))
    .filter((j) => {
      const anchor = j.lastRunAt ?? j.updatedAt;
      return new Date(anchor).getTime() >= cutoff;
    })
    .sort(
      (a, b) =>
        new Date(b.lastRunAt ?? b.updatedAt).getTime() -
        new Date(a.lastRunAt ?? a.updatedAt).getTime(),
    )
    .slice(0, 20);

  if (recent.length === 0) {
    return "_No non-sleep jobs active in the last 7 days._";
  }

  return recent
    .map((j) => {
      const last = j.lastRunAt ?? j.updatedAt;
      const output = j.lastOutput?.trim().slice(0, 300) ?? "";
      const err = j.error?.trim().slice(0, 120) ?? "";
      const tail = output
        ? `\n  Last output: ${output}${j.lastOutput && j.lastOutput.length > 300 ? "…" : ""}`
        : err
          ? `\n  Error: ${err}`
          : "";
      return `- **${j.name}** (${j.type}, ${j.status}) — last activity ${last}${tail}`;
    })
    .join("\n");
}

function jobHasArchitectureErrors(job: Pick<JobRecord, "type" | "command" | "appIds">): boolean {
  const issues = validateJobArchitecture(job);
  return Boolean(formatJobArchitectureErrors(issues));
}

export class SleepCycleService {
  /**
   * Ensure one sleep job, dedupe extras, refresh prompt + defaults.
   */
  async syncSleepJobs(): Promise<void> {
    try {
      const { getJobsService } = await import("./JobsService.js");
      const jobsService = getJobsService();
      await jobsService.initialize();

      const sleepPrompt = await readSleepPrompt();
      const allJobs = await jobsService.listJobs();
      const sleepJobs = allJobs.filter((j) => isSleepCycleJobName(j.name));

      if (sleepJobs.length === 0) {
        const job = await jobsService.createJob({
          name: "Papr Sleep Cycle",
          type: "agent",
          appIds: [STANDALONE_APP_ID],
          command: sleepPrompt,
          schedule: SLEEP_JOB_DEFAULTS.schedule,
          memoryPolicy: SLEEP_JOB_DEFAULTS.memoryPolicy,
          maxTurns: SLEEP_JOB_DEFAULTS.maxTurns,
          provider: SLEEP_JOB_DEFAULTS.provider,
          model: SLEEP_JOB_DEFAULTS.model,
          retries: SLEEP_JOB_DEFAULTS.retries,
        });
        await this.writeTaskMd(jobsService, job.id, sleepPrompt);
        console.log("[SleepCycleService] Created Papr Sleep Cycle job");
        return;
      }

      const keeper = pickKeeperJob(sleepJobs);
      const duplicates = sleepJobs.filter((j) => j.id !== keeper.id);

      for (const dup of duplicates) {
        console.log(
          `[SleepCycleService] Removing duplicate sleep job ${dup.id} (${dup.name})`,
        );
        await jobsService.deleteJob(dup.id, true);
      }

      const needsUpdate =
        keeper.provider !== SLEEP_JOB_DEFAULTS.provider ||
        keeper.model !== SLEEP_JOB_DEFAULTS.model ||
        keeper.maxTurns !== SLEEP_JOB_DEFAULTS.maxTurns ||
        keeper.command !== sleepPrompt ||
        keeper.retries?.maxAttempts !== SLEEP_JOB_DEFAULTS.retries.maxAttempts ||
        jobHasArchitectureErrors(keeper);

      if (needsUpdate) {
        if (jobHasArchitectureErrors(keeper) && keeper.command !== sleepPrompt) {
          console.warn(
            `[SleepCycleService] Repairing sleep job ${keeper.id} — architecture validation failed (stale prompt)`,
          );
        }
        await jobsService.updateJob(keeper.id, {
          command: sleepPrompt,
          provider: SLEEP_JOB_DEFAULTS.provider,
          model: SLEEP_JOB_DEFAULTS.model,
          maxTurns: SLEEP_JOB_DEFAULTS.maxTurns,
          memoryPolicy: SLEEP_JOB_DEFAULTS.memoryPolicy,
          retries: SLEEP_JOB_DEFAULTS.retries,
          schedule: keeper.schedule?.enabled
            ? keeper.schedule
            : SLEEP_JOB_DEFAULTS.schedule,
        });
        await this.writeTaskMd(jobsService, keeper.id, sleepPrompt);
        console.log(
          `[SleepCycleService] Updated sleep job ${keeper.id} (Claude Sonnet, maxTurns=100, prompt v${SLEEP_PROMPT_VERSION})`,
        );
      } else {
        console.log("[SleepCycleService] Sleep job already synced");
      }
    } catch (error) {
      console.warn("[SleepCycleService] syncSleepJobs failed:", error);
    }
  }

  private async writeTaskMd(
    jobsService: { getJobPath: (id: string) => Promise<string | null> },
    jobId: string,
    prompt: string,
  ): Promise<void> {
    const jobDir = await jobsService.getJobPath(jobId);
    if (jobDir) {
      await fs.writeFile(path.join(jobDir, "task.md"), prompt, "utf8");
    }
  }

  /**
   * Build context injected before the SLEEP.md prompt on each run.
   */
  async buildPreflightContext(sleepJobId: string): Promise<string> {
    const sections: string[] = [
      "# Preloaded Sleep Context",
      "",
      "_Auto-generated at run start. Verify with tools; prioritize new signal over prior sleep summaries._",
      "",
      "## Active workspace paths",
      "",
      `- PAPR_HOME: ${process.env.PAPR_HOME ?? "(unset — use getPaprRoot())"}`,
      `- PAPR_USER_DATA: ${process.env.PAPR_USER_DATA ?? "(unset)"}`,
      `- Organization: ${process.env.PAPR_ORG_ID ?? "(unset)"}`,
      `- Namespace: ${process.env.PAPR_NAMESPACE_ID ?? "(unset)"}`,
      "",
      "Use these paths for workspace memory, chat exports, and chats.db — not legacy ~/Papr or ~/.paprwork-v2.",
      "",
    ];

    try {
      const { getStorageManager } = await import("./StorageManager.js");
      const storage = getStorageManager();
      if (storage.isInitialized()) {
        const summaries = await storage.listRecentChatSummaries(20, 7);
        sections.push("## Recent chat summaries (last 7 days)", "");
        sections.push(formatChatSummaries(summaries));
        sections.push("");
      }
    } catch (error) {
      sections.push(
        "## Recent chat summaries",
        "",
        `_Could not load: ${error instanceof Error ? error.message : String(error)}_`,
        "",
      );
    }

    try {
      const { getJobsService } = await import("./JobsService.js");
      const jobsService = getJobsService();
      const jobs = await jobsService.listJobs();
      sections.push("## Recent job activity (last 7 days)", "");
      sections.push(formatRecentJobs(jobs, sleepJobId));
      sections.push("");
    } catch (error) {
      sections.push(
        "## Recent job activity",
        "",
        `_Could not load: ${error instanceof Error ? error.message : String(error)}_`,
        "",
      );
    }

    try {
      const { loadGatewayProfile, getWorkspaceFileHealth, formatWorkspaceFileHealthForSleep } =
        await import("./identityAboutSeed.js");
      const profile = await loadGatewayProfile();
      const health = await getWorkspaceFileHealth();
      sections.push(formatWorkspaceFileHealthForSleep(health, profile));
    } catch (error) {
      sections.push(
        "## Workspace file health",
        "",
        `_Could not load: ${error instanceof Error ? error.message : String(error)}_`,
        "",
      );
    }

    try {
      const { getUserMemoryContextService } =
        await import("./UserMemoryContextService.js");
      const blocks =
        await getUserMemoryContextService().fetchSleepBootstrapBlocks();
      if (blocks.length > 0) {
        sections.push("## User goals, use cases & Papr Memory (bootstrap)", "");
        sections.push(...blocks);
        sections.push("");
      }
    } catch (error) {
      console.warn("[SleepCycleService] Bootstrap blocks failed:", error);
    }

    return sections.join("\n");
  }
}

let instance: SleepCycleService | null = null;

export function getSleepCycleService(): SleepCycleService {
  if (!instance) {
    instance = new SleepCycleService();
  }
  return instance;
}
