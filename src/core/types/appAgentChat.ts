/**
 * Embedded sub-agent chat configuration for mini-apps (desktop + published web).
 */

export type AppAgentChatBubblePosition = "bottom-right" | "bottom-left";

/** Tool ids recommended for in-app assistants (app-scoped edits + data). */
export const DEFAULT_APP_AGENT_CHAT_TOOL_IDS = [
  "read_app_file",
  "edit_app_file",
  "edit_app_file_lines",
  "list_app_files",
  "read_app_data_sources",
  "read_app_data_health",
] as const;

export interface AppAgentChatConfig {
  /** When false, SDK mount is a no-op. */
  enabled: boolean;
  /** Sub-agent profile id from create_sub_agent / list_sub_agents. */
  subAgentId: string;
  /** Shown in the chat bubble header (defaults to sub-agent name). */
  bubbleLabel?: string;
  /** First message shown when the panel opens. */
  welcomeMessage?: string;
  /** Extra system context injected for every session (app purpose, UX rules). */
  systemContext?: string;
  /** Override sub-agent tools for embedded sessions (Phase 2 executor merge). */
  allowedToolIds?: string[];
  bubblePosition?: AppAgentChatBubblePosition;
  /** ISO timestamp when agent chat was enabled. */
  enabledAt?: string;
  /** Hidden subagent job id for cloud SSE turns (synced via metadata.json). */
  cloudJobId?: string;
}

export type AppAgentChatMessageRole = "user" | "assistant";

export interface AppAgentChatMessage {
  id: string;
  role: AppAgentChatMessageRole;
  content: string;
  timestamp: string;
}

export interface AppAgentChatSession {
  id: string;
  appId: string;
  subAgentId: string;
  messages: AppAgentChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export type AppAgentChatSseEventType =
  | "app-agent:turn-start"
  | "app-agent:status"
  | "app-agent:thinking-delta"
  | "app-agent:text-delta"
  | "app-agent:tool-call"
  | "app-agent:tool-result"
  | "app-agent:tool-error"
  | "app-agent:turn-done"
  | "app-agent:error";

export interface AppAgentChatSseEvent {
  type: AppAgentChatSseEventType;
  data: Record<string, unknown>;
}

/** Cloud gateway sandbox warm state (intent-based pre-warm on bubble open). */
export type AppAgentWarmStatus =
  | "idle"
  | "warming"
  | "ready"
  | "unavailable"
  | "failed";

export interface AppAgentWarmResponse {
  status: AppAgentWarmStatus;
  sessionId: string;
  expiresAt?: string;
  message?: string;
}

/** Tools that should trigger app refresh after successful writes. */
export const APP_AGENT_FILE_WRITE_TOOL_IDS = [
  "edit_app_file",
  "edit_app_file_lines",
  "write_app_file",
] as const;

/** Block main-agent relay tools in embedded app chat. */
export const APP_AGENT_BLOCKED_TOOL_IDS = [
  "delegate_task",
  "request_agent_input",
  "enable_app_agent_chat",
] as const;

export function filterEmbeddedAppAgentToolIds(
  toolIds: readonly string[] | undefined,
): string[] {
  const blocked = new Set<string>(APP_AGENT_BLOCKED_TOOL_IDS);
  const source =
    toolIds && toolIds.length > 0 ? toolIds : [...DEFAULT_APP_AGENT_CHAT_TOOL_IDS];
  const filtered = source.filter((id) => !blocked.has(id));
  return filtered.length > 0 ? filtered : [...DEFAULT_APP_AGENT_CHAT_TOOL_IDS];
}

/** Public subset exposed to mini-app clients (no internal-only fields). */
export interface PublicAppAgentChatConfig {
  enabled: boolean;
  subAgentId: string;
  bubbleLabel?: string;
  welcomeMessage?: string;
  bubblePosition?: AppAgentChatBubblePosition;
}

export function toPublicAppAgentChatConfig(
  config: AppAgentChatConfig,
): PublicAppAgentChatConfig {
  return {
    enabled: config.enabled,
    subAgentId: config.subAgentId,
    ...(config.bubbleLabel ? { bubbleLabel: config.bubbleLabel } : {}),
    ...(config.welcomeMessage ? { welcomeMessage: config.welcomeMessage } : {}),
    ...(config.bubblePosition ? { bubblePosition: config.bubblePosition } : {}),
  };
}

export function buildAppAgentChatContext(
  appId: string,
  appTitle: string,
  config: AppAgentChatConfig,
): string {
  const lines = [
    `Embedded app assistant for mini-app "${appTitle}" (appId: ${appId}).`,
    "Users chat from inside the app UI — respond directly to them (not via main-agent relay).",
    "You may read/edit app files and linked data sources for this app only.",
    "After writes, the app UI may refresh automatically — confirm what changed.",
  ];
  if (config.systemContext?.trim()) {
    lines.push("", config.systemContext.trim());
  }
  return lines.join("\n");
}
