/**
 * Hidden agent job backing Papr Web workspace chat — parity with desktop Pen (main agent).
 */

import type { JobRecord } from "../../gateway/services/jobs/types.js";
import { DEFAULT_AGENT_MAX_TURNS } from "./agentLimits.js";
import { STANDALONE_APP_ID } from "../../gateway/services/jobs/appIds.js";

export const WORKSPACE_CHAT_JOB_ID = "workspace-chat";

export function isWorkspaceChatJob(jobId: string | undefined): boolean {
  return jobId?.trim() === WORKSPACE_CHAT_JOB_ID;
}

/** Stable chats.db id prefix for warm Papr Web sessions. */
export function workspaceChatSessionId(workspaceSessionId: string): string {
  return `workspace-chat:${workspaceSessionId.trim()}`;
}

/**
 * Default job record — same tool budget as main Pen; provider/model from vault at runtime.
 * Omit allowedToolIds so gateway exposes the full main-agent tool registry.
 */
export function buildWorkspaceChatJobRecord(
  now: string = new Date().toISOString(),
): Partial<JobRecord> & Pick<JobRecord, "id" | "name" | "type"> {
  return {
    id: WORKSPACE_CHAT_JOB_ID,
    name: "Main Agent",
    type: "agent",
    status: "pending",
    appIds: [STANDALONE_APP_ID],
    command:
      "Papr Web chat turn. The user's message arrives via runtimeParams.prompt; " +
      "conversation history loads from the warm sandbox chats.db.",
    maxTurns: DEFAULT_AGENT_MAX_TURNS,
    memoryPolicy: "none",
    outputMode: "natural",
    dependsOn: [],
    retries: { maxAttempts: 1, backoffMs: 1000 },
    retentionDays: 14,
    createdAt: now,
    updatedAt: now,
  };
}
