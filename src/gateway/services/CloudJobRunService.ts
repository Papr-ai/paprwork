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
import { CLOUD_AGENT_JOB_TIMEOUT_MS } from "../../core/constants/cloudAgentLimits.js";
import { buildJobRunDimensions } from "../../core/telemetry/jobRunTelemetry.js";
import { getGatewayTelemetry } from "./gatewayTelemetry.js";

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

/**
 * Cloud runs previously emitted nothing, so total agent hours silently meant
 * "local only". Same event names and dimension builder as the local path, with
 * surface=cloud as the only difference — so charts can sum both or split them.
 */
function emitCloudRunTelemetry(
  job: JobRecord,
  payload: CloudJobRunApiResponse,
  durationMs: number,
): void {
  const succeeded = payload.exitCode === 0;
  const dimensions = buildJobRunDimensions({
    jobId: job.id,
    jobType: job.type,
    appIds: job.appIds,
    durationMs,
    surface: "cloud",
    // Reached only via the explicit run-in-cloud action; scheduled cloud runs
    // report through applyCloudRunPatch instead.
    trigger: "manual",
    subAgentId: job.subAgentId,
  });

  getGatewayTelemetry().trackFireAndForget(
    succeeded ? "paprwork_job_completed" : "paprwork_job_failed",
    succeeded
      ? { ...dimensions, exit_code: payload.exitCode, attempts: 1 }
      : {
          ...dimensions,
          exit_code: payload.exitCode,
          error_type: `exit_${payload.exitCode}`,
          attempts: 1,
        },
  );
}

async function syncAfterCloudRun(
  jobsService: JobsService,
  jobId: string,
  payload: CloudJobRunApiResponse,
): Promise<void> {
  await jobsService.applyCloudRunPatch({
    jobId,
    status: payload.status,
    exitCode: payload.exitCode,
    lastOutput: payload.lastOutput ?? payload.stdout,
    error: payload.error,
    recordedAt: new Date().toISOString(),
    source: "cloud_manual",
  });
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
  // Measured around the request only. Includes cloud queue + execution, which
  // is the wall-clock time the user actually waited for the agent's work.
  const startedAt = Date.now();
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
  emitCloudRunTelemetry(job, payload, Date.now() - startedAt);

  const updated = await jobsService.getJob(jobId);
  if (!updated) {
    throw new Error(`Job missing after cloud run: ${jobId}`);
  }

  console.log(
    `[CloudJobRun] ${jobId} finished exitCode=${payload.exitCode} backend=${payload.backend ?? "unknown"}`,
  );
  return updated;
}
