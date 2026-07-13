/**
 * Memory-search-first reminder — nudges exploration tools to call
 * search_agent_memory once per turn (when Papr is configured), without blocking.
 *
 * Pattern: soft guidance in tool results, same scope as the former hard gate.
 */

import type { AnyTool } from "../agents/ToolRegistry.js";

const SEARCH_TOOL_ID = "search_agent_memory";

/** Tools that satisfy the reminder (memory recall, not file/grep exploration). */
const MEMORY_SATISFYING_TOOLS = new Set<string>([
  SEARCH_TOOL_ID,
  "query_memory_graph",
  "introspect_memory_graph",
  "get_wiki_entity",
  "search_wiki_entities",
]);

/**
 * Discovery/list/search tools that receive a memory-search reminder until recall
 * happens once this turn. Targeted reads and browser/webview tools stay silent.
 */
const EXPLORATION_REMINDER_TOOLS = new Set<string>([
  "list_directory",
  "search_files",
  "list_app_files",
  "list_apps",
  "list_job_files",
  "get_project_code_overview",
  "get_file_code_summary",
  "list_file_code_summaries",
]);

interface TurnGateState {
  active: boolean;
  memorySearchCompleted: boolean;
  reminderDeliveredThisTurn: boolean;
}

let turnGate: TurnGateState = {
  active: false,
  memorySearchCompleted: false,
  reminderDeliveredThisTurn: false,
};

/** Reset at the start of each streamAgent user turn. */
export function initializeMemorySearchGate(options: {
  allowedToolIds?: string[];
  hasPaprApiKey: boolean;
}): void {
  const { allowedToolIds, hasPaprApiKey } = options;
  const searchToolAvailable =
    !allowedToolIds ||
    allowedToolIds.length === 0 ||
    allowedToolIds.includes(SEARCH_TOOL_ID);

  turnGate = {
    active: hasPaprApiKey && searchToolAvailable,
    memorySearchCompleted: false,
    reminderDeliveredThisTurn: false,
  };
}

export function markMemorySearchCompleted(): void {
  turnGate.memorySearchCompleted = true;
}

export function isMemorySearchGateActive(): boolean {
  return turnGate.active && !turnGate.memorySearchCompleted;
}

function isTrivialBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/^(pwd|whoami|date|clear|true|false)\s*$/.test(trimmed)) {
    return true;
  }
  if (/^echo(\s|$)/.test(trimmed)) {
    return true;
  }
  if (/^cd(\s|$)/.test(trimmed)) {
    return true;
  }
  if (/^ls(\s|$)/.test(trimmed)) {
    return true;
  }
  if (/^git\s+(status|log|diff|branch)(\s|$)/.test(trimmed)) {
    return true;
  }
  return isDirectFileReadBashCommand(trimmed);
}

/** Single-file reads (cat/head/tail/sed) — not open-ended grep/find/sqlite exploration. */
export function isDirectFileReadBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/^(cat|head|tail|less|more|wc)\b/.test(trimmed)) {
    return true;
  }
  if (/^sed\s+-n\b/.test(trimmed)) {
    return true;
  }
  if (/^python3?\s+-c\s/.test(trimmed) && /open\s*\(/.test(trimmed)) {
    return true;
  }
  if (/^node\s+-e\s/.test(trimmed) && /readFileSync|createReadStream/.test(trimmed)) {
    return true;
  }
  return false;
}

function extractBashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const wrapped = input as { context?: { command?: string }; command?: string };
  const args = wrapped.context ?? wrapped;
  if (typeof args.command === "string") {
    return args.command;
  }
  return undefined;
}

function shouldRemindForTool(toolId: string, input: unknown): boolean {
  if (!isMemorySearchGateActive()) {
    return false;
  }
  if (MEMORY_SATISFYING_TOOLS.has(toolId)) {
    return false;
  }
  if (EXPLORATION_REMINDER_TOOLS.has(toolId)) {
    return true;
  }
  if (toolId === "bash") {
    const command = extractBashCommand(input);
    if (!command) {
      return true;
    }
    return !isTrivialBashCommand(command);
  }
  return false;
}

export function buildMemorySearchReminderText(_toolId: string): string {
  return (
    `Tip: search_agent_memory is the best tool for mini-app and job code (indexed in Papr Memory) ` +
    `AND for prior decisions, uploaded docs, and cross-chat facts. ` +
    `For code: category "code" + projectId/projectType + a 2-3 sentence query. ` +
    `For context: query + chatId "current_chat". ` +
    `Prefer it over grep/list exploration — grep is only for exact symbol/text matches.`
  );
}

export function getMemorySearchReminderForTool(
  toolId: string,
  input: unknown,
): string | null {
  if (!shouldRemindForTool(toolId, input)) {
    return null;
  }
  if (turnGate.reminderDeliveredThisTurn) {
    return null;
  }
  turnGate.reminderDeliveredThisTurn = true;
  return buildMemorySearchReminderText(toolId);
}

export function appendMemorySearchReminderToResult(
  result: unknown,
  toolId: string,
  input: unknown,
): unknown {
  const reminder = getMemorySearchReminderForTool(toolId, input);
  if (!reminder) {
    return result;
  }

  if (!result || typeof result !== "object") {
    return { _memorySearchReminder: reminder, data: result };
  }

  const obj = result as Record<string, unknown>;
  const withReminder: Record<string, unknown> = {
    ...obj,
    _memorySearchReminder: reminder,
  };

  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    withReminder.data = {
      ...(obj.data as Record<string, unknown>),
      _memorySearchReminder: reminder,
    };
  }

  return withReminder;
}

function wrapToolExecute(tool: AnyTool, toolId: string): AnyTool {
  const originalExecute = tool.execute?.bind(tool);
  if (!originalExecute) {
    return tool;
  }

  return {
    ...tool,
    execute: async (inputData: unknown, context: unknown) => {
      if (MEMORY_SATISFYING_TOOLS.has(toolId)) {
        try {
          const result = await originalExecute(inputData, context);
          markMemorySearchCompleted();
          return result;
        } catch (error) {
          // Prevent repeat reminders when search fails (API error, timeout, etc.)
          markMemorySearchCompleted();
          throw error;
        }
      }

      const result = await originalExecute(inputData, context);
      return appendMemorySearchReminderToResult(result, toolId, inputData);
    },
  } as AnyTool;
}

/** Wrap exploration tools with a soft memory-search reminder until recall this turn. */
export function wrapToolsWithMemorySearchFirstGate(
  tools: Record<string, AnyTool>,
): Record<string, AnyTool> {
  if (!turnGate.active) {
    return tools;
  }

  const wrapped: Record<string, AnyTool> = {};
  for (const [id, tool] of Object.entries(tools)) {
    if (
      MEMORY_SATISFYING_TOOLS.has(id) ||
      EXPLORATION_REMINDER_TOOLS.has(id) ||
      id === "bash"
    ) {
      wrapped[id] = wrapToolExecute(tool, id);
    } else {
      wrapped[id] = tool;
    }
  }
  return wrapped;
}
