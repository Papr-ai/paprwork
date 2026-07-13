/**
 * Papr Cursor proxy API types.
 *
 * CURSOR_API_KEY lives ONLY on the memory server. Paprwork sends requests to
 * /v1/ai/cursor/* with PAPR_API_KEY — same pattern as other AI proxy routes.
 * The key never transits to the client.
 */

export interface CursorRunStreamRequest {
  chatId: string;
  prompt: string;
  model: string;
  /** Resume an existing server-side Cursor agent for multi-turn chats. */
  agentId?: string;
  /** Optional workspace hint (server decides how to use it). */
  cwd?: string;
  /** Optional GitHub repos for cloud agent runs. */
  repos?: Array<{
    url: string;
    startingRef?: string;
  }>;
}

export interface CursorRunStreamEvent {
  type:
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
}

export interface CursorDelegationErrorResponse {
  detail?: string;
  error?: string;
  message?: string;
}

export const CURSOR_DEFAULT_MODEL = "composer-2.5";

export const CURSOR_MODEL_ALIASES: Record<string, string> = {
  "composer-2": "composer-2.5",
  "composer-2-fast": "composer-2.5",
  "composer-2.5": "composer-2.5",
};

export function normalizeCursorModelId(modelId: string): string {
  return CURSOR_MODEL_ALIASES[modelId] ?? modelId;
}
