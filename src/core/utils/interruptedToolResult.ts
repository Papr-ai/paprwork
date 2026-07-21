/**
 * Detect and normalize tool calls whose results were not persisted
 * (stream interrupted before execution finished).
 */

export type ToolCallStatus =
  | "calling"
  | "success"
  | "error"
  | "interrupted";

export const INTERRUPTED_RESULT_MARKER =
  "[Tool result not persisted";

export function isInterruptedToolResult(result: unknown): boolean {
  if (result === undefined || result === null) {
    return false;
  }

  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (record.__orphan === true) {
      return true;
    }
  }

  if (typeof result === "string") {
    if (result.includes(INTERRUPTED_RESULT_MARKER)) {
      return true;
    }
    try {
      const parsed: unknown = JSON.parse(result);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>).__orphan === true
      ) {
        return true;
      }
    } catch {
      // Not JSON — fall through
    }
  }

  return false;
}

export function resolveToolCallStatus(args: {
  explicitStatus?: string;
  hasError?: boolean;
  result?: unknown;
}): ToolCallStatus {
  if (args.explicitStatus === "calling") {
    return "calling";
  }
  if (args.hasError || args.explicitStatus === "error") {
    return "error";
  }
  if (
    args.explicitStatus === "interrupted" ||
    args.explicitStatus === "orphaned"
  ) {
    return "interrupted";
  }
  if (isInterruptedToolResult(args.result)) {
    return "interrupted";
  }
  return "success";
}
