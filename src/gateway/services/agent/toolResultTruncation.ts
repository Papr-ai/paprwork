/**
 * Category-based tool result truncation for cross-turn history loading.
 *
 * Keeps the system prompt static (prompt-cache friendly). All shaping happens
 * when formatting stored messages for the model in historyFormatter.
 *
 * File reads stay full up to the absolute cap in history (prompt-cache friendly
 * below the cap). Limits are user-configurable in Settings → AI Models → Agent Context.
 */

import {
  getToolResultTruncationSettings,
  isToolResultTruncationDisabled,
} from "./toolResultTruncationSettings.js";
import { resolvePaprUserDataPath } from "../../../core/utils/paprWorkspace.js";
import path from "path";

/** Default hard ceiling (~10K tokens at ~4 chars/token). Overridable in settings. */
export const ABSOLUTE_TOOL_RESULT_MAX_CHARS = 40_000;

/** Default cross-turn limit for noisy / low-reuse tools (bash, lists, etc.) */
export const HISTORY_TOOL_RESULT_MAX_CHARS = 400;

/** Limits at or below this use deterministic head+tail truncation (cache-stable). */
export const HEAD_TAIL_TRUNCATION_MAX_CHARS = 2000;

const HEAD_TAIL_OMITTED_MARKER = "\n[... omitted ...]\n";

/** Default moderate limit for small structured results (code summaries, schema list) */
export const HISTORY_TOOL_RESULT_MODERATE_CHARS = 2000;

/** Default user turns before bash/discovery results truncate aggressively */
export const RECENT_TURN_RETENTION_COUNT = 4;

function effectiveAbsoluteMaxChars(): number | null {
  const { disableAllTruncation, absoluteMaxChars } =
    getToolResultTruncationSettings();
  if (disableAllTruncation) {
    return null;
  }
  return absoluteMaxChars;
}

function effectiveRecentTurnRetentionCount(): number {
  return getToolResultTruncationSettings().recentTurnRetentionCount;
}

/** @deprecated File reads are kept full; reserved for footprint estimates / future caps */
export const ACTIVE_FILE_READ_MAX_CHARS = 15_000;

export type ToolResultCategory =
  | "file_read"
  | "file_edit"
  | "code_cache"
  | "bash"
  | "directory_list"
  | "memory_search"
  | "validation_preview"
  | "job_run"
  | "small_crud"
  | "orphan_marker";

const FILE_READ_TOOLS = new Set([
  "read_file",
  "read_app_file",
  "read_job_file",
]);

const CODE_CACHE_TOOLS = new Set([
  "get_project_code_overview",
  "get_file_code_summary",
  "list_file_code_summaries",
]);

const DIRECTORY_LIST_TOOLS = new Set([
  "list_directory",
  "list_app_files",
  "list_job_files",
  "search_files",
]);

const MEMORY_SEARCH_TOOLS = new Set([
  "search_agent_memory",
  "query_memory_graph",
  "introspect_memory_graph",
  "get_wiki_entity",
  "search_wiki_entities",
  "get_full_tool_result",
]);

const VALIDATION_PREVIEW_TOOLS = new Set([
  "validate_app",
  "webview_snapshot",
  "webview_execute",
  "browser_snapshot",
  "browser_navigate",
  "browser_parse_html",
]);

const JOB_RUN_TOOLS = new Set([
  "run_job",
  "get_job_history",
  "get_job_stats",
  "get_job_logs",
  "read_job_logs",
]);

const SMALL_CRUD_TOOLS = new Set([
  "create_app",
  "create_job",
  "update_job",
  "create_plan",
  "update_plan",
  "delete_plan",
  "provision_service",
  "connect_service",
  "get_schema",
  "list_schemas",
  "list_skills",
  "read_skill",
  "list_sub_agents",
]);

/** Recovery + delegation status tools — never truncate (full payload must survive). */
export const FULL_RETENTION_TOOLS = new Set([
  "get_full_tool_result",
  "get_delegation_run",
]);

export function isFullRetentionTool(toolName: string): boolean {
  return FULL_RETENTION_TOOLS.has(toolName);
}

/**
 * Discovery tools that stay full for RECENT_TURN_RETENTION_COUNT user turns
 * (same window as bash) so list/graph/schema results are reusable without re-fetch.
 */
const RECENT_TURN_DISCOVERY_TOOLS = new Set([
  "list_jobs",
  "list_apps",
  "list_job_files",
  "list_app_files",
  "list_directory",
  "search_files",
  "list_sub_agents",
  "introspect_memory_graph",
  "query_memory_graph",
  "get_wiki_entity",
  "search_wiki_entities",
]);

export interface HistoryMessageLike {
  role?: unknown;
  message_role?: unknown;
  content?: unknown;
  message?: unknown;
  tool_calls?: unknown;
  toolCalls?: unknown;
}

export function categorizeTool(toolName: string): ToolResultCategory {
  if (FILE_READ_TOOLS.has(toolName)) return "file_read";
  if (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "edit_app_file" ||
    toolName === "edit_app_file_lines" ||
    toolName === "edit_job_file"
  ) {
    return "file_edit";
  }
  if (CODE_CACHE_TOOLS.has(toolName)) return "code_cache";
  if (toolName === "bash") return "bash";
  if (DIRECTORY_LIST_TOOLS.has(toolName)) return "directory_list";
  if (MEMORY_SEARCH_TOOLS.has(toolName)) return "memory_search";
  if (VALIDATION_PREVIEW_TOOLS.has(toolName)) return "validation_preview";
  if (JOB_RUN_TOOLS.has(toolName)) return "job_run";
  if (SMALL_CRUD_TOOLS.has(toolName)) return "small_crud";
  if (toolName.startsWith("browser_")) return "validation_preview";
  return "bash";
}

/** Category limits from settings (ignores disableAllTruncation). */
function getConfiguredCategoryCharLimit(
  category: ToolResultCategory,
  toolName?: string,
): number | null {
  const { aggressiveMaxChars, moderateMaxChars, memorySearchMaxChars } =
    getToolResultTruncationSettings();

  if (toolName === "validate_app") {
    return moderateMaxChars;
  }

  switch (category) {
    case "file_read":
    case "file_edit":
    case "orphan_marker":
      return null;
    case "code_cache":
    case "small_crud":
      return moderateMaxChars;
    case "memory_search":
      return memorySearchMaxChars;
    case "bash":
    case "directory_list":
    case "validation_preview":
    case "job_run":
    default:
      return aggressiveMaxChars;
  }
}

/** `null` = keep full result (file reads, edits, orphan markers). */
export function getDefaultHistoryCharLimit(
  category: ToolResultCategory,
  toolName?: string,
): number | null {
  if (isToolResultTruncationDisabled()) {
    return null;
  }

  return getConfiguredCategoryCharLimit(category, toolName);
}

function buildTruncationSuffix(
  omitted: number,
  toolCallId: string,
  toolName: string,
): string {
  const chatsDbPath = path.join(resolvePaprUserDataPath(), "chats.db");
  return (
    `\n[... ${omitted} chars truncated. ` +
    `Tool: get_full_tool_result({ toolCallId: "${toolCallId}", toolName: "${toolName}" }) ` +
    `OR query: ${chatsDbPath} → messages.parts (JSONL)]`
  );
}

function truncateHeadOnly(
  resultStr: string,
  maxChars: number,
  toolCallId: string,
  toolName: string,
): string {
  const omittedEstimate = Math.max(0, resultStr.length - maxChars);
  const suffix = buildTruncationSuffix(omittedEstimate, toolCallId, toolName);
  const contentMax = maxChars - suffix.length;
  if (contentMax <= 0) {
    return resultStr.substring(0, maxChars);
  }
  const content = resultStr.substring(0, contentMax);
  const omitted = resultStr.length - content.length;
  return content + buildTruncationSuffix(omitted, toolCallId, toolName);
}

function truncateHeadTail(
  resultStr: string,
  maxChars: number,
  toolCallId: string,
  toolName: string,
): string {
  let suffix = buildTruncationSuffix(resultStr.length, toolCallId, toolName);
  let budget = maxChars - suffix.length - HEAD_TAIL_OMITTED_MARKER.length;
  if (budget < 40) {
    return truncateHeadOnly(resultStr, maxChars, toolCallId, toolName);
  }

  let headLen = Math.ceil(budget * 0.6);
  let tailLen = budget - headLen;

  const build = (head: number, tail: number): string => {
    const omitted = resultStr.length - head - tail;
    const recoverySuffix = buildTruncationSuffix(omitted, toolCallId, toolName);
    return (
      resultStr.substring(0, head) +
      HEAD_TAIL_OMITTED_MARKER +
      resultStr.substring(resultStr.length - tail) +
      recoverySuffix
    );
  };

  let combined = build(headLen, tailLen);
  if (combined.length <= maxChars) {
    return combined;
  }

  const overflow = combined.length - maxChars;
  headLen = Math.max(10, headLen - Math.ceil(overflow * 0.6));
  tailLen = Math.max(10, tailLen - Math.floor(overflow * 0.4));
  combined = build(headLen, tailLen);
  if (combined.length <= maxChars) {
    return combined;
  }

  return truncateHeadOnly(resultStr, maxChars, toolCallId, toolName);
}

export function truncateToCharLimit(
  resultStr: string,
  maxChars: number | null,
  toolCallId: string,
  toolName: string,
): string {
  if (maxChars === null || resultStr.length <= maxChars) {
    return resultStr;
  }

  if (maxChars <= HEAD_TAIL_TRUNCATION_MAX_CHARS) {
    return truncateHeadTail(resultStr, maxChars, toolCallId, toolName);
  }

  return truncateHeadOnly(resultStr, maxChars, toolCallId, toolName);
}

export interface TruncateHistoryToolResultInput {
  toolName: string;
  toolCallId: string;
  args: unknown;
  resultStr: string;
  history: HistoryMessageLike[];
  messageIndex: number;
  isOrphan: boolean;
}

function extractHistoryRole(
  message: HistoryMessageLike,
): "user" | "assistant" | "system" | null {
  const role = message.role ?? message.message_role;
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }
  return null;
}

/** User messages after `messageIndex` — proxy for how many turns ago a tool result was fetched. */
export function countUserTurnsAfter(
  history: HistoryMessageLike[],
  messageIndex: number,
): number {
  let count = 0;
  for (let i = messageIndex + 1; i < history.length; i += 1) {
    if (extractHistoryRole(history[i]!) === "user") {
      count += 1;
    }
  }
  return count;
}

function isRecentTurnDiscoveryRetentionEligible(
  toolName: string,
  category: ToolResultCategory,
): boolean {
  if (isFullRetentionTool(toolName)) {
    return false;
  }
  if (RECENT_TURN_DISCOVERY_TOOLS.has(toolName)) {
    return true;
  }
  return category === "bash" || category === "directory_list";
}

/**
 * Resolve the character limit for one tool result when loading cross-turn history.
 */
export function resolveHistoryToolResultCharLimit(
  input: TruncateHistoryToolResultInput,
): number | null {
  if (isToolResultTruncationDisabled()) {
    return null;
  }

  if (input.isOrphan) {
    return null;
  }

  if (isFullRetentionTool(input.toolName)) {
    return null;
  }

  const absoluteMax = effectiveAbsoluteMaxChars();
  const category = categorizeTool(input.toolName);
  const defaultLimit = getDefaultHistoryCharLimit(category, input.toolName);

  if (
    defaultLimit !== null &&
    isRecentTurnDiscoveryRetentionEligible(input.toolName, category) &&
    countUserTurnsAfter(input.history, input.messageIndex) <
      effectiveRecentTurnRetentionCount()
  ) {
    return absoluteMax;
  }

  if (defaultLimit === null) {
    return absoluteMax;
  }

  if (absoluteMax === null) {
    return defaultLimit;
  }

  return Math.min(defaultLimit, absoluteMax);
}

/** Mid-turn / in-flight context: cap unless tool is full-retention (recovery/delegation). */
export function truncateToolResultForModelContext(
  resultStr: string,
  toolCallId: string,
  toolName: string,
): string {
  if (isToolResultTruncationDisabled() || isFullRetentionTool(toolName)) {
    return resultStr;
  }
  return truncateToCharLimit(
    resultStr,
    effectiveAbsoluteMaxChars(),
    toolCallId,
    toolName,
  );
}

export function truncateHistoryToolResult(
  input: TruncateHistoryToolResultInput,
): string {
  const limit = resolveHistoryToolResultCharLimit(input);
  return truncateToCharLimit(
    input.resultStr,
    limit,
    input.toolCallId,
    input.toolName,
  );
}

/**
 * Mid-turn compaction: effective char limit for one tool result in a batch.
 * File reads/edits use the absolute cap; category limits apply otherwise.
 */
export function resolveMidTurnToolResultCharLimit(
  toolName: string | undefined,
  batchCeiling: number,
): number {
  if (toolName && isFullRetentionTool(toolName)) {
    return Number.MAX_SAFE_INTEGER;
  }

  const absoluteMax = effectiveAbsoluteMaxChars();
  const category = toolName ? categorizeTool(toolName) : "bash";
  const historyLimit = getConfiguredCategoryCharLimit(category, toolName);

  if (historyLimit === null) {
    return absoluteMax ?? Number.MAX_SAFE_INTEGER;
  }

  const cappedBatch = absoluteMax === null ? batchCeiling : Math.min(batchCeiling, absoluteMax);
  return Math.min(cappedBatch, historyLimit);
}
