/**
 * Papr cloud runtime API types (Phase 3C/3D).
 *
 * Unified streaming via POST /v1/cloud/runtime/sessions/stream.
 * Provider keys stay on the memory server — Paprwork sends PAPR_API_KEY only.
 */

export type CloudRuntimeTier = "sandbox" | "ephemeral";

export interface CloudRuntimeStreamRequest {
  chatId: string;
  prompt: string;
  provider: string;
  model: string;
  agentId?: string;
  tier?: CloudRuntimeTier;
  runtime?: "cloud";
}

export interface CloudRuntimeStreamEvent {
  type:
    | "session-meta"
    | "text-delta"
    | "reasoning-start"
    | "reasoning-delta"
    | "reasoning-end"
    | "tool-call"
    | "tool-result"
    | "error"
    | "done"
    | "agent-meta"
    | "status";
  text?: string;
  message?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  agentId?: string;
  runId?: string;
  finishReason?: string;
  provider?: string;
  tier?: string;
  chatId?: string;
  runtime?: string;
}

export interface CloudRuntimeErrorResponse {
  detail?: string;
  error?: string;
  message?: string;
}

export interface PendingCloudRunNotification {
  orgId?: string;
  namespaceId?: string;
  userId?: string;
  jobId: string;
  jobName?: string;
  status: string;
  exitCode?: number;
  lastOutput?: string;
  source?: string;
  recordedAt?: string;
}

export interface DesktopHeartbeatResponse {
  recordedAt: string;
  staleAfterSeconds: number;
  desktopAwake: boolean;
  pendingCloudRuns?: PendingCloudRunNotification[];
}
