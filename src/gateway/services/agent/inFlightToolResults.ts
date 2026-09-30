/**
 * In-memory full tool results for the active streaming turn.
 * SQLite checkpoints are debounced (5s) or run on first tool-call only,
 * so get_full_tool_result must read here during the same assistant turn.
 */

export interface InFlightToolResult {
  toolName: string;
  result: string;
}

const inFlightByChat = new Map<string, Map<string, InFlightToolResult>>();

function formatToolResultForLookup(result: unknown): string {
  if (result === undefined || result === null) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function clearInFlightToolResults(chatId: string): void {
  inFlightByChat.delete(chatId);
}

export function recordInFlightToolResult(
  chatId: string,
  toolCallId: string,
  toolName: string,
  result: unknown,
): void {
  if (!toolCallId.trim()) {
    return;
  }
  let chatMap = inFlightByChat.get(chatId);
  if (!chatMap) {
    chatMap = new Map();
    inFlightByChat.set(chatId, chatMap);
  }
  chatMap.set(toolCallId, {
    toolName,
    result: formatToolResultForLookup(result),
  });
}

function normalizeInFlightToolCallId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 64 ? sanitized.substring(0, 64) : sanitized;
}

function inFlightToolCallIdsMatch(storedId: string, requestedId: string): boolean {
  if (storedId === requestedId) {
    return true;
  }
  return (
    normalizeInFlightToolCallId(storedId) ===
    normalizeInFlightToolCallId(requestedId)
  );
}

export function getInFlightToolResult(
  chatId: string,
  toolCallId: string,
): InFlightToolResult | undefined {
  const chatMap = inFlightByChat.get(chatId);
  if (!chatMap) {
    return undefined;
  }

  const direct = chatMap.get(toolCallId);
  if (direct) {
    return direct;
  }

  for (const [storedId, result] of chatMap) {
    if (inFlightToolCallIdsMatch(storedId, toolCallId)) {
      return result;
    }
  }

  return undefined;
}

/** Reset between unit tests. */
export function resetInFlightToolResultsForTests(): void {
  inFlightByChat.clear();
}
