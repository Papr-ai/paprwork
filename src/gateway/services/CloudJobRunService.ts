/**
 * Run a synced job on Papr Cloud while the desktop is awake (manual cloud test path).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import { getCloudSyncService } from "./CloudSyncService.js";
import type { JobRecord } from "./jobs/types.js";
import type { JobsService } from "./JobsService.js";
import { isJobRuntimeOffGit } from "./jobs/jobRuntimeOffGit.js";
import { CLOUD_AGENT_JOB_TIMEOUT_MS } from "../../core/constants/cloudAgentLimits.js";

export type JobRunRuntime = "local" | "cloud";

interface CloudJobRunApiResponse {
  jobId: string;
  name?: string;
  type?: string;
  status: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  lastOutput?: string;
  error?: string | null;
  backend?: string;
  tier?: string;
}

function jobLogPath(jobId: string): string {
  return path.join(getPaprRoot(), "Jobs", jobId, "logs", "run.log");
}

function cloudRunTimeoutMs(job: JobRecord): number {
  if (job.type === "agent" || job.type === "subagent") {
    return CLOUD_AGENT_JOB_TIMEOUT_MS;
  }
  return 600_000;
}

async function appendCloudRunLog(
  jobId: string,
  payload: CloudJobRunApiResponse,
): Promise<void> {
  const logPath = jobLogPath(jobId);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const stamp = new Date().toISOString();
  const header = `\n[${stamp}] ☁️ Cloud run (backend=${payload.backend ?? "unknown"})\n`;
  const body = [payload.stdout, payload.stderr].filter(Boolean).join("\n");
  const footer = `\nexitCode=${payload.exitCode} status=${payload.status}\n`;
  await fs.appendFile(logPath, `${header}${body}${footer}`, "utf8");
}

async function syncAfterCloudRun(
  jobsService: JobsService,
  jobId: string,
  payload: CloudJobRunApiResponse,
): Promise<void> {
  if (isJobRuntimeOffGit()) {
    await jobsService.applyCloudRunPatch({
      jobId,
      status: payload.status,
      exitCode: payload.exitCode,
      lastOutput: payload.lastOutput ?? payload.stdout,
      error: payload.error,
      recordedAt: new Date().toISOString(),
      source: "cloud_manual",
    });
    return;
  }

  const cloudSync = getCloudSyncService();
  if (cloudSync) {
    try {
      await cloudSync.pullNow();
    } catch (err) {
      console.warn(
        "[CloudJobRun] Pull after cloud run failed:",
        (err as Error).message.slice(0, 120),
      );
    }
  }

  await jobsService.reloadJobs();
}

export async function runJobInCloud(
  jobsService: JobsService,
  jobId: string,
): Promise<JobRecord> {
  const job = await jobsService.getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  if (job.status === "running" || job.status === "waiting_permission") {
    throw new Error(`Job is already running locally: ${job.name}`);
  }

  const cloudSync = getCloudSyncService();
  if (cloudSync) {
    console.log(`[CloudJobRun] Pushing workspace before cloud run: ${jobId}`);
    try {
      await cloudSync.pushNow();
    } catch (err) {
      console.warn(
        "[CloudJobRun] Pre-run push failed (continuing):",
        (err as Error).message.slice(0, 120),
      );
    }
  } else {
    console.warn(
      "[CloudJobRun] Cloud Sync not active — cloud may run last-pushed GitHub state",
    );
  }

  const timeoutMs = cloudRunTimeoutMs(job);
  const res = await cloudApiFetch("/v1/cloud/runtime/job-run", {
    method: "POST",
    body: {
      jobId,
      tier: "sandbox",
      timeoutMs,
    },
    timeoutMs: timeoutMs + 30_000,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Cloud job run failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }

  const payload = (await res.json()) as CloudJobRunApiResponse;
  await appendCloudRunLog(jobId, payload);
  await syncAfterCloudRun(jobsService, jobId, payload);

  const updated = await jobsService.getJob(jobId);
  if (!updated) {
    throw new Error(`Job missing after cloud run: ${jobId}`);
  }

  console.log(
    `[CloudJobRun] ${jobId} finished exitCode=${payload.exitCode} backend=${payload.backend ?? "unknown"}`,
  );
  return updated;
}
