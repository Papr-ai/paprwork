/**
 * Detect and normalize tool calls whose results were not persisted
 * (stream interrupted before execution finished).
 */

export type ToolCallStatus =
  | "calling"
  | "success"
  | "warning"
  | "error"
  | "interrupted";

export const INTERRUPTED_RESULT_MARKER =
  "[Tool result not persisted";

export interface ToolValidationIssue {
  file?: string;
  line?: number;
  severity?: string;
  message?: string;
  rule?: string;
}

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

export function parseResultRecord(result: unknown): Record<string, unknown> | null {
  if (result === null || result === undefined) {
    return null;
  }
  if (typeof result === "object") {
    return result as Record<string, unknown>;
  }
  if (typeof result === "string") {
    try {
      const parsed: unknown = JSON.parse(result);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Extract validation issues from standard tool result shapes. */
export function extractValidationIssues(
  record: Record<string, unknown>,
): ToolValidationIssue[] {
  const data =
    typeof record.data === "object" && record.data !== null
      ? (record.data as Record<string, unknown>)
      : null;
  if (!data) {
    return [];
  }

  const nestedSources: unknown[] = [
    data.issues,
    (data.validation as Record<string, unknown> | undefined)?.issues,
    (data.buildCheck as Record<string, unknown> | undefined)?.issues,
  ];

  for (const source of nestedSources) {
    if (Array.isArray(source)) {
      return source.filter(
        (item): item is ToolValidationIssue =>
          typeof item === "object" && item !== null,
      );
    }
  }

  return [];
}

export function countValidationIssues(issues: ToolValidationIssue[]): {
  errorCount: number;
  warningCount: number;
} {
  let errorCount = 0;
  let warningCount = 0;
  for (const issue of issues) {
    if (issue.severity === "warning") {
      warningCount += 1;
    } else if (issue.severity === "error") {
      errorCount += 1;
    }
  }
  return { errorCount, warningCount };
}

function truncateLine(text: string, maxLen = 180): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return text.trim();
}

function formatIssueSummary(issues: ToolValidationIssue[]): string | undefined {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  const formatOne = (issue: ToolValidationIssue): string => {
    const filePrefix = issue.file ? `${issue.file}: ` : "";
    return `${filePrefix}${issue.message ?? "Validation issue"}`;
  };

  if (errors.length > 0) {
    const head = formatOne(errors[0]);
    return errors.length > 1
      ? `${errors.length} errors — ${truncateLine(head)}`
      : truncateLine(head);
  }

  if (warnings.length > 0) {
    const head = formatOne(warnings[0]);
    return warnings.length > 1
      ? `${warnings.length} warnings — ${truncateLine(head)}`
      : truncateLine(head);
  }

  return undefined;
}

/** Short message for UI under a tool row (error or warning detail). */
export function getToolResultFeedback(args: {
  status: ToolCallStatus;
  result?: unknown;
  toolError?: string;
}): { message: string; detail?: string } | null {
  if (args.status === "calling" || args.status === "success") {
    return null;
  }

  if (args.status === "interrupted") {
    return {
      message: "Interrupted before this tool finished",
    };
  }

  const record = parseResultRecord(args.result);
  const issues = record ? extractValidationIssues(record) : [];
  const issueSummary = issues.length > 0 ? formatIssueSummary(issues) : undefined;

  const errorText =
    typeof args.toolError === "string" && args.toolError.trim().length > 0
      ? args.toolError.trim()
      : record && typeof record.error === "string" && record.error.trim().length > 0
        ? record.error.trim()
        : undefined;

  if (args.status === "warning") {
    return {
      message: issueSummary ?? truncateLine(firstMeaningfulLine(errorText ?? "Completed with warnings")),
      detail: errorText,
    };
  }

  if (errorText) {
    return {
      message: issueSummary ?? truncateLine(firstMeaningfulLine(errorText)),
      detail: errorText,
    };
  }

  if (issueSummary) {
    return { message: issueSummary };
  }

  return { message: "Agent will retry with a different approach" };
}

/** Tool results that hard-failed (blocking errors or thrown errors). */
export function isFailedToolResult(result: unknown): boolean {
  return resolveToolCallStatus({ result }) === "error";
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

  const record = parseResultRecord(args.result);
  if (record) {
    const issues = extractValidationIssues(record);
    const { errorCount, warningCount } = countValidationIssues(issues);

    if (record.success === false) {
      if (errorCount > 0) {
        return "error";
      }
      if (warningCount > 0) {
        return "warning";
      }
      if (typeof record.error === "string" && record.error.trim().length > 0) {
        return "error";
      }
      return "error";
    }

    if (errorCount > 0) {
      return "error";
    }
    if (warningCount > 0) {
      return "warning";
    }

    if (typeof record.error === "string" && record.error.trim().length > 0) {
      return "error";
    }

    return "success";
  }

  return "success";
}
