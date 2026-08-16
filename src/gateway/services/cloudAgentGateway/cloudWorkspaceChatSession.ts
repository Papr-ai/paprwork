/**
 * Papr Web workspace chat — main Pen parity on Cloud Agent Gateway warm sessions.
 */

import {
  isWorkspaceChatJob,
  WORKSPACE_CHAT_JOB_ID,
  workspaceChatSessionId,
} from "../../../core/constants/workspaceChatJob.js";
import { getAgentService } from "../AgentService.js";
import {
  isCloudAppAgentWarmSession,
  resolveCloudAppAgentUserMessage,
} from "./cloudAppAgentSession.js";
import type { CloudAgentRunRequest } from "./types.js";

export interface CloudWorkspaceChatStreamOverrides {
  chatId: string;
  userMessage: string;
  systemPrompt: string;
}

export async function resolveCloudWorkspaceChatStreamOverrides(
  request: CloudAgentRunRequest,
): Promise<CloudWorkspaceChatStreamOverrides | null> {
  if (
    !isCloudAppAgentWarmSession(request) ||
    !request.workspaceSessionId ||
    !isWorkspaceChatJob(request.jobId)
  ) {
    return null;
  }

  const agentService = getAgentService();
  if (!agentService.isInitialized()) {
    throw new Error("AgentService is not initialized");
  }

  return {
    chatId: workspaceChatSessionId(request.workspaceSessionId),
    userMessage: resolveCloudAppAgentUserMessage(request),
    systemPrompt: agentService.getDefaultSystemPrompt(),
  };
}

export { WORKSPACE_CHAT_JOB_ID };
