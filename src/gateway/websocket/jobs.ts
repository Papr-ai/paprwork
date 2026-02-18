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
import { getApiKeysForSanitization, sanitizeError } from "../../core/tools/security.js";

interface CreateJobPayload {
  name: string;
  type: JobType;
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

interface JobIdPayload {
  jobId: string;
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

export async function setupJobsHandlers(
  ws: WebSocket,
  message: WSMessage,
): Promise<void> {
  const jobsService = getJobsService();

  try {
    switch (message.type) {
      case "jobs:list": {
        const jobs = await jobsService.listJobs();
        sendResponse(ws, { id: message.id, success: true, data: jobs });
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
        const payload = message.payload as JobIdPayload;
        const job = await jobsService.runJob(payload.jobId);
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
        const result = await jobsService.deleteJob(payload.jobId, payload.deleteFiles ?? false);
        sendResponse(ws, { id: message.id, success: true, data: result });
        break;
      }
      case "jobs:logs": {
        const payload = message.payload as JobLogsPayload;
        const rawLogs = await jobsService.getLogs(payload.jobId, payload.maxBytes);
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
      default:
        sendError(ws, message.id, `Unknown jobs message type: ${message.type}`);
    }
  } catch (error) {
    console.error("[Jobs WebSocket] Error:", error);
    sendError(ws, message.id, error as Error);
  }
}
