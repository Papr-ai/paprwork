import type { WebSocket } from "ws";
import type { WSMessage } from "./index.js";
import { sendError, sendResponse } from "./index.js";
import {
  getJobsService,
  type JobDelivery,
  type JobDependency,
  type JobMemoryPolicy,
  type JobRetryPolicy,
  type JobSchedule,
  type JobType,
} from "../services/JobsService.js";
import {
  getApiKeysForSanitization,
  sanitizeError,
} from "../../core/tools/security.js";

interface CreateJobPayload {
  name: string;
  type: JobType;
  appIds: string[];
  folder?: string;
  command?: string;
  dependsOn?: JobDependency[];
  retries?: JobRetryPolicy;
  deliver?: JobDelivery;
  retentionDays?: number;
  schedule?: JobSchedule;
  subAgentId?: string;
  delegatedBy?: string;
  delegationTask?: string;
  delegationContext?: string;
  outputMode?: "natural" | "structured";
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: JobMemoryPolicy;
  reportChatId?: string;
}

interface RunJobPayload {
  jobId: string;
  runtime?: "local" | "cloud";
}

interface JobFilePayload {
  jobId: string;
  filename: string;
}

interface WriteJobFilePayload {
  jobId: string;
  filename: string;
  content: string;
}

interface JobDbPreviewPayload {
  jobId: string;
  filename: string;
  tableName?: string;
}

interface JobIdPayload {
  jobId: string;
}

interface ListJobsPayload {
  folder?: string;
  appId?: string;
}

interface JobLogsPayload {
  jobId: string;
  maxBytes?: number;
}

interface DeleteJobPayload {
  jobId: string;
  deleteFiles?: boolean;
}

interface UpdateJobPayload {
  jobId: string;
  name?: string;
  appIds?: string[];
  folder?: string;
  command?: string;
  requirements?: string[];
  dependsOn?: JobDependency[];
  retries?: JobRetryPolicy;
  deliver?: JobDelivery;
  retentionDays?: number;
  schedule?: JobSchedule;
  outputMode?: "natural" | "structured";
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: "none" | "summary" | "full";
  reportChatId?: string;
}

interface JobDbInfoPayload {
  jobId: string;
}

interface JobFileVersionsPayload {
  jobId: string;
  filename: string;
}

interface JobFileVersionPayload {
  jobId: string;
  filename: string;
  versionId: string;
}

interface RestoreJobFileVersionPayload {
  jobId: string;
  filename: string;
  versionId: string;
}

interface JobRunDashboardPayload {
  recentLimit?: number;
}

export async function setupJobsHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const jobsService = getJobsService();

  try {
    switch (message.type) {
      case "jobs:list": {
        const listPayload = message.payload as ListJobsPayload | undefined;
        const jobs = await jobsService.listJobs(
          (listPayload?.folder ?? listPayload?.appId)
            ? { folder: listPayload?.folder, appId: listPayload?.appId }
            : undefined,
        );
        sendResponse(ws, { id: message.id, success: true, data: jobs });
        break;
      }
      case "jobs:folders": {
        const folders = await jobsService.listJobFolders();
        sendResponse(ws, { id: message.id, success: true, data: { folders } });
        break;
      }
      case "jobs:graph": {
        const graph = await jobsService.getJobGraph();
        sendResponse(ws, { id: message.id, success: true, data: { graph } });
        break;
      }
      case "jobs:default-model": {
        const { getDefaultProviderAndModel } = await import("../utils/defaultProvider.js");
        const defaults = await getDefaultProviderAndModel();
        sendResponse(ws, { id: message.id, success: true, data: defaults });
        break;
      }
      case "jobs:get": {
        const payload = message.payload as JobIdPayload;
        const job = await jobsService.getJob(payload.jobId);
        if (!job) {
          sendError(ws, message.id, `Job not found: ${payload.jobId}`);
          return;
        }
        sendResponse(ws, { id: message.id, success: true, data: job });
        break;
      }
      case "jobs:create": {
        const payload = message.payload as CreateJobPayload;
        const job = await jobsService.createJob({
          name: payload.name,
          type: payload.type,
          appIds: payload.appIds,
          folder: payload.folder,
          command: payload.command,
          dependsOn: payload.dependsOn,
          retries: payload.retries,
          deliver: payload.deliver,
          retentionDays: payload.retentionDays,
          schedule: payload.schedule,
          subAgentId: payload.subAgentId,
          delegatedBy: payload.delegatedBy,
          delegationTask: payload.delegationTask,
          delegationContext: payload.delegationContext,
          outputMode: payload.outputMode,
          outputSchema: payload.outputSchema,
          maxTurns: payload.maxTurns,
          memoryPolicy: payload.memoryPolicy,
          reportChatId: payload.reportChatId,
        });
        sendResponse(ws, { id: message.id, success: true, data: job });
        break;
      }
      case "jobs:run": {
        const payload = message.payload as RunJobPayload;
        const job =
          payload.runtime === "cloud"
            ? await jobsService.runJobInCloud(payload.jobId)
            : await jobsService.runJob(payload.jobId);
        sendResponse(ws, { id: message.id, success: true, data: job });
        break;
      }
      case "jobs:stop": {
        const payload = message.payload as JobIdPayload;
        const job = await jobsService.stopJob(payload.jobId);
        sendResponse(ws, { id: message.id, success: true, data: job });
        break;
      }
      case "jobs:update": {
        const payload = message.payload as UpdateJobPayload;
        const { jobId, ...updates } = payload;
        const job = await jobsService.updateJob(jobId, updates);
        sendResponse(ws, { id: message.id, success: true, data: job });
        break;
      }
      case "jobs:delete": {
        const payload = message.payload as DeleteJobPayload;
        const result = await jobsService.deleteJob(
          payload.jobId,
          payload.deleteFiles ?? false,
        );
        sendResponse(ws, { id: message.id, success: true, data: result });
        break;
      }
      case "jobs:logs": {
        const payload = message.payload as JobLogsPayload;
        const rawLogs = await jobsService.getLogs(
          payload.jobId,
          payload.maxBytes,
        );
        const logs = sanitizeError(rawLogs, getApiKeysForSanitization());
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { jobId: payload.jobId, logs },
        });
        break;
      }
      case "jobs:db-info": {
        const payload = message.payload as JobDbInfoPayload;
        const dbPath = await jobsService.getJobDatabasePath(payload.jobId);
        if (!dbPath) {
          sendError(ws, message.id, `Job not found: ${payload.jobId}`);
          return;
        }
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { jobId: payload.jobId, dbPath },
        });
        break;
      }
      // ========== FILE VERSION HISTORY ==========
      case "jobs:file-versions": {
        const payload = message.payload as JobFileVersionsPayload;
        const versions = await jobsService.getJobFileVersionHistory(
          payload.jobId,
          payload.filename,
        );
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: versions,
        });
        break;
      }

      case "jobs:file-version": {
        const payload = message.payload as JobFileVersionPayload;
        const version = await jobsService.getJobFileVersion(
          payload.jobId,
          payload.filename,
          payload.versionId,
        );
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: version,
        });
        break;
      }

      case "jobs:restore-file-version": {
        const payload = message.payload as RestoreJobFileVersionPayload;
        const restored = await jobsService.restoreJobFileVersion(
          payload.jobId,
          payload.filename,
          payload.versionId,
        );
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { restored },
        });
        break;
      }

      case "jobs:read-file": {
        const payload = message.payload as JobFilePayload;
        const content = await jobsService.readJobFile(
          payload.jobId,
          payload.filename,
        );
        if (content === null) {
          sendError(
            ws,
            message.id,
            `File not found: ${payload.filename} in job ${payload.jobId}`,
          );
          return;
        }
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { content },
        });
        break;
      }

      case "jobs:write-file": {
        const payload = message.payload as WriteJobFilePayload;
        const success = await jobsService.writeJobFile(
          payload.jobId,
          payload.filename,
          payload.content,
        );
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: { success },
        });
        break;
      }

      case "jobs:db-preview": {
        const payload = message.payload as JobDbPreviewPayload;
        const preview = await jobsService.previewJobDatabase(
          payload.jobId,
          payload.filename,
          payload.tableName,
        );
        sendResponse(ws, {
          id: message.id,
          success: true,
          data: preview,
        });
        break;
      }

      case "jobs:run-dashboard": {
        const payload = (message.payload ?? {}) as JobRunDashboardPayload;
        const { getJobRunHistory } = await import(
          "../services/jobs/JobRunHistory.js"
        );
        const runHistory = getJobRunHistory();
        await runHistory.initialize();

        const [summary, recentRuns, jobs] = await Promise.all([
          runHistory.getGlobalSummary(),
          runHistory.getAllRuns(payload.recentLimit ?? 5),
          jobsService.listJobs(),
        ]);

        const jobNameById = new Map(jobs.map((job) => [job.id, job.name]));
        const activeJobs = jobs.filter(
          (job) =>
            job.status === "running" || job.status === "waiting_permission",
        ).length;

        sendResponse(ws, {
          id: message.id,
          success: true,
          data: {
            totalJobs: jobs.length,
            activeJobs,
            totalRuns: summary.totalRuns,
            completedRuns: summary.completedRuns,
            failedRuns: summary.failedRuns,
            cancelledRuns: summary.cancelledRuns,
            successRate: summary.successRate,
            topJobs: summary.topJobs.map((entry) => ({
              jobId: entry.jobId,
              jobName: jobNameById.get(entry.jobId) ?? entry.jobId,
              runs: entry.runs,
              completed: entry.completed,
              failed: entry.failed,
            })),
            recentRuns: recentRuns.map((run) => ({
              runId: run.runId,
              jobId: run.jobId,
              jobName: jobNameById.get(run.jobId) ?? run.jobId,
              status: run.status,
              startedAt: run.startedAt,
              completedAt: run.completedAt,
              duration: run.duration,
            })),
          },
        });
        break;
      }

      default:
        sendError(ws, message.id, `Unknown jobs message type: ${message.type}`);
    }
  } catch (error) {
    console.error("[Jobs WebSocket] Error:", error);
    sendError(ws, message.id, error as Error);
  }
}
