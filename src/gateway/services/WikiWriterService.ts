/**
 * WikiWriterService — built-in entity wiki maintenance job sync
 *
 * Ensures exactly one "Wiki Writer" agent job exists per user,
 * keeps config current, and builds preflight context for each run.
 * Runs after Sleep Cycle completes — reads daily logs and graph
 * changes, then updates entity markdown files incrementally.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const WIKI_WRITER_JOB_NAMES = [
  "Wiki Writer",
  "wiki-writer",
] as const;
export const WIKI_WRITER_PROMPT_VERSION = 7;

export const WIKI_WRITER_JOB_DEFAULTS = {
  provider: "anthropic" as const,
  model: "claude-sonnet-5",
  maxTurns: 80,
  memoryPolicy: "none" as const,
  schedule: {
    enabled: true,
    cron: "30 19 * * *", // 7:30pm — 30min after Sleep
  },
  retries: {
    maxAttempts: 2,
    backoffMs: 5000,
  },
};

export function isWikiWriterJobName(name: string): boolean {
  return (WIKI_WRITER_JOB_NAMES as readonly string[]).includes(name);
}

/** Last successful Wiki Writer run time, if the job exists. */
export async function getWikiWriterLastRunAt(): Promise<string | null> {
  try {
    const { getJobsService } = await import("./JobsService.js");
    const jobs = await getJobsService().listJobs();
    const wikiJob = jobs.find((job) => isWikiWriterJobName(job.name));
    return wikiJob?.lastRunAt ?? wikiJob?.completedAt ?? null;
  } catch {
    return null;
  }
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

function wikiPromptVersion(content: string): number {
  const match = content.match(/wiki-writer-prompt-version:\s*(\d+)/);
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

async function readWikiWriterPrompt(): Promise<string> {
  const templatesDir = resolveTemplatesDir();
  const templatePath = path.join(templatesDir, "WIKI_WRITER.md");
  const workspacePath = path.join(workspaceDir(), "WIKI_WRITER.md");

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
    const wsVersion = wikiPromptVersion(workspaceContent);
    const tplVersion = templateContent
      ? wikiPromptVersion(templateContent)
      : 0;

    if (tplVersion > wsVersion && templateContent) {
      await fs.writeFile(workspacePath, templateContent, "utf8");
      console.log(
        `[WikiWriterService] Upgraded WIKI_WRITER.md v${wsVersion} → v${tplVersion}`,
      );
      return normalizePortableJobPrompt(templateContent);
    }
    return normalizePortableJobPrompt(workspaceContent);
  }

  return normalizePortableJobPrompt(
    templateContent ||
      "Maintain entity wiki pages in $PAPR_HOME/workspace/entities/ based on daily logs and graph changes.",
  );
}

function jobHasArchitectureErrors(job: Pick<JobRecord, "type" | "command" | "appIds">): boolean {
  const issues = validateJobArchitecture(job);
  return Boolean(formatJobArchitectureErrors(issues));
}

function pickKeeperJob(jobs: JobRecord[]): JobRecord {
  return [...jobs].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )[0];
}

export class WikiWriterService {
  /**
   * Ensure one wiki writer job, dedupe extras, refresh prompt + defaults.
   */
  async syncWikiWriterJobs(): Promise<void> {
    try {
      const { getJobsService } = await import("./JobsService.js");
      const jobsService = getJobsService();
      await jobsService.initialize();

      const wikiPrompt = await readWikiWriterPrompt();
      const allJobs = await jobsService.listJobs();
      const wikiJobs = allJobs.filter((j) => isWikiWriterJobName(j.name));

      // Find the Sleep job to set up dependency
      const { isSleepCycleJobName } = await import("./SleepCycleService.js");
      const sleepJob = allJobs.find((j) => isSleepCycleJobName(j.name));

      const dependsOn = sleepJob
        ? [
            {
              jobId: sleepJob.id,
              onStatus: "completed" as const,
              autoTrigger: true,
            },
          ]
        : [];

      if (wikiJobs.length === 0) {
        await jobsService.createJob({
          name: "Wiki Writer",
          type: "agent",
          appIds: [STANDALONE_APP_ID],
          command: wikiPrompt,
          schedule: WIKI_WRITER_JOB_DEFAULTS.schedule,
          memoryPolicy: WIKI_WRITER_JOB_DEFAULTS.memoryPolicy,
          maxTurns: WIKI_WRITER_JOB_DEFAULTS.maxTurns,
          provider: WIKI_WRITER_JOB_DEFAULTS.provider,
          model: WIKI_WRITER_JOB_DEFAULTS.model,
          retries: WIKI_WRITER_JOB_DEFAULTS.retries,
          dependsOn,
        });
        console.log("[WikiWriterService] Created Wiki Writer job");
        return;
      }

      const keeper = pickKeeperJob(wikiJobs);
      const duplicates = wikiJobs.filter((j) => j.id !== keeper.id);

      for (const dup of duplicates) {
        console.log(
          `[WikiWriterService] Removing duplicate wiki writer job ${dup.id} (${dup.name})`,
        );
        await jobsService.deleteJob(dup.id, true);
      }

      // Sync config if needed
      const needsUpdate =
        keeper.provider !== WIKI_WRITER_JOB_DEFAULTS.provider ||
        keeper.model !== WIKI_WRITER_JOB_DEFAULTS.model ||
        keeper.maxTurns !== WIKI_WRITER_JOB_DEFAULTS.maxTurns ||
        keeper.command !== wikiPrompt ||
        jobHasArchitectureErrors(keeper);

      if (needsUpdate) {
        if (jobHasArchitectureErrors(keeper) && keeper.command !== wikiPrompt) {
          console.warn(
            `[WikiWriterService] Repairing wiki writer job ${keeper.id} — architecture validation failed (stale prompt)`,
          );
        }
        await jobsService.updateJob(keeper.id, {
          provider: WIKI_WRITER_JOB_DEFAULTS.provider,
          model: WIKI_WRITER_JOB_DEFAULTS.model,
          maxTurns: WIKI_WRITER_JOB_DEFAULTS.maxTurns,
          command: wikiPrompt,
        });
        console.log(
          `[WikiWriterService] Updated Wiki Writer job config/prompt`,
        );
      }

      // Ensure dependency on Sleep if not already set
      if (sleepJob && (!keeper.dependsOn || keeper.dependsOn.length === 0)) {
        await jobsService.updateJob(keeper.id, { dependsOn });
        console.log(
          `[WikiWriterService] Added Sleep dependency to Wiki Writer`,
        );
      }
    } catch (err) {
      console.error("[WikiWriterService] Failed to sync wiki writer jobs:", err);
    }
  }

  /**
   * Build preflight context for the wiki writer agent run.
   * Includes: today's daily log excerpt (active entities), entity directory listing.
   */
  async buildPreflightContext(_jobId: string): Promise<string> {
    const parts: string[] = [];

    // 1. Today's daily log (or most recent)
    try {
      const memoryDir = path.join(workspaceDir(), "memory");
      const files = await fs.readdir(memoryDir);
      const mdFiles = files
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse();

      if (mdFiles.length > 0) {
        const latest = await fs.readFile(
          path.join(memoryDir, mdFiles[0]),
          "utf8",
        );
        parts.push(
          `## Latest Daily Log (${mdFiles[0].replace(".md", "")})\n\n${latest.slice(0, 3000)}`,
        );
      }
    } catch {
      // no daily logs yet
    }

    // 2. Current entity directory
    try {
      const entitiesDir = path.join(workspaceDir(), "entities");
      if (await fileExists(entitiesDir)) {
        const types = await fs.readdir(entitiesDir);
        const listing: string[] = [];
        for (const type of types) {
          const typePath = path.join(entitiesDir, type);
          const stat = await fs.stat(typePath);
          if (stat.isDirectory()) {
            const entityFiles = await fs.readdir(typePath);
            const mdFiles = entityFiles.filter((f) => f.endsWith(".md"));
            listing.push(`- **${type}/**: ${mdFiles.length} entities`);
          }
        }
        if (listing.length > 0) {
          parts.push(
            `## Current Entity Wiki\n\n${listing.join("\n")}\n\nTotal entity files across all types.`,
          );
        }
      }
    } catch {
      // no entities yet
    }

    if (parts.length === 0) return "";
    return `---\n## Preloaded Wiki Writer Context\n\n${parts.join("\n\n")}\n---`;
  }
}

let _instance: WikiWriterService | null = null;

export function getWikiWriterService(): WikiWriterService {
  if (!_instance) {
    _instance = new WikiWriterService();
  }
  return _instance;
}
