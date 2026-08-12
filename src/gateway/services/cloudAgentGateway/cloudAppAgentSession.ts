/**
 * App-agent warm session helpers — stable chat id + per-sandbox user data paths.
 */

import path from "path";
import { STANDALONE_APP_ID } from "../jobs/appIds.js";
import {
  DEFAULT_APP_AGENT_CHAT_TOOL_IDS,
  filterEmbeddedAppAgentToolIds,
} from "../../../core/types/appAgentChat.js";
import type { CloudAgentRunRequest } from "./types.js";
import { getJobsService } from "../JobsService.js";
import { getAppService } from "../AppService.js";
import { getSubAgentService } from "../SubAgentService.js";
import { buildEmbeddedSubAgentSystemPrompt } from "../appAgentChat/appAgentChatPrompt.js";

export function isCloudAppAgentWarmSession(request: CloudAgentRunRequest): boolean {
  return Boolean(request.workspaceSessionId?.trim() && request.keepWorkspaceWarm);
}

/** Stable chat id for warm app-agent turns; per-run id for one-shot cloud jobs. */
export function resolveCloudAgentChatId(request: CloudAgentRunRequest): string {
  if (isCloudAppAgentWarmSession(request) && request.workspaceSessionId) {
    return `app-agent:${request.workspaceSessionId}`;
  }
  return `job:${request.jobId}:${request.runId}`;
}

/** Per-sandbox runtime data (chats.db, tool results) — not shared across sessions. */
export function resolveCloudUserDataPath(runRoot: string): string {
  return path.join(runRoot, "user-data");
}

export function resolveCloudAppAgentUserMessage(
  request: CloudAgentRunRequest,
): string {
  const fromParams =
    request.runtimeParams?.userMessage?.trim() ??
    request.runtimeParams?.prompt?.trim() ??
    "";
  if (fromParams) {
    return fromParams;
  }
  const legacy = request.prompt?.trim();
  if (legacy) {
    return legacy;
  }
  throw new Error(
    "App-agent turn requires runtimeParams.prompt (user message) from memory server",
  );
}

export interface CloudAppAgentStreamOverrides {
  chatId: string;
  userMessage: string;
  systemPrompt: string;
  allowedToolIds: string[];
}

/**
 * Desktop-parity app-agent turn: embedded system prompt + single user message;
 * prior turns + tool results load from chats.db via stable chatId.
 */
export async function resolveCloudAppAgentStreamOverrides(
  request: CloudAgentRunRequest,
): Promise<CloudAppAgentStreamOverrides | null> {
  if (!isCloudAppAgentWarmSession(request) || !request.workspaceSessionId) {
    return null;
  }

  const jobsService = getJobsService();
  const appService = getAppService();
  const subAgentService = getSubAgentService();
  await jobsService.initialize();
  await appService.initialize();
  await subAgentService.initialize();

  const job = await jobsService.getJob(request.jobId);
  if (!job) {
    throw new Error(`Job not found in cloned workspace: ${request.jobId}`);
  }

  const linkedAppId = (job.appIds ?? []).find((id) => id !== STANDALONE_APP_ID);
  if (!linkedAppId) {
    throw new Error(`App-agent job ${request.jobId} is not linked to a mini-app`);
  }

  const app = await appService.getApp(linkedAppId);
  if (!app) {
    throw new Error(`Mini-app not found in cloned workspace: ${linkedAppId}`);
  }

  const agentChat = app.agentChat;
  if (!agentChat?.enabled) {
    throw new Error(`App agent chat is not enabled for app ${linkedAppId}`);
  }

  const profile = await subAgentService.getAgent(agentChat.subAgentId);
  if (!profile) {
    throw new Error(`Sub-agent not found: ${agentChat.subAgentId}`);
  }

  const systemPrompt = await buildEmbeddedSubAgentSystemPrompt({
    appId: linkedAppId,
    appTitle: app.title,
    agentChat,
    subAgentName: profile.name,
    subAgentSystemPrompt: profile.systemPrompt,
  });

  const allowedToolIds = filterEmbeddedAppAgentToolIds(
    request.allowedToolIds ??
      agentChat.allowedToolIds ??
      profile.allowedToolIds ??
      [...DEFAULT_APP_AGENT_CHAT_TOOL_IDS],
  );

  return {
    chatId: resolveCloudAgentChatId(request),
    userMessage: resolveCloudAppAgentUserMessage(request),
    systemPrompt,
    allowedToolIds,
  };
}
