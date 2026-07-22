/**
 * Caps validation issue lists in tool output (cache-stable, smaller prefix).
 * Full issue list remains in `data.issues` on validate_app responses.
 */

export const MAX_VALIDATION_ISSUES_IN_TOOL_OUTPUT = 8;

export interface ValidationIssueLike {
  file: string;
  line?: number;
  severity: "error" | "warning";
  message: string;
}

export function formatValidationIssueLine(
  issue: ValidationIssueLike,
  includeLine = true,
): string {
  const location =
    includeLine && issue.line !== undefined ? `:${issue.line}` : "";
  const icon = issue.severity === "error" ? "❌" : "⚠️";
  return `- ${icon} ${issue.file}${location}: ${issue.message}`;
}

export function buildCappedValidationIssueList(
  issues: ValidationIssueLike[],
  options?: { includeLine?: boolean; omittedHint?: string },
): string {
  const includeLine = options?.includeLine ?? true;
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const ordered = [...errors, ...warnings];
  const shown = ordered.slice(0, MAX_VALIDATION_ISSUES_IN_TOOL_OUTPUT);
  const lines = shown.map((issue) =>
    formatValidationIssueLine(issue, includeLine),
  );
  const omitted = ordered.length - shown.length;
  if (omitted <= 0) {
    return lines.join("\n");
  }
  const hint =
    options?.omittedHint ??
    `… and ${omitted} more issue(s) — run validate_app({ appId }) for the full list`;
  return [...lines, `- ${hint}`].join("\n");
}

export function buildCappedRuntimeErrorList(
  errors: string[],
  maxShown = MAX_VALIDATION_ISSUES_IN_TOOL_OUTPUT,
): string {
  const shown = errors.slice(0, maxShown);
  const lines = shown.map((line) => `- ❌ ${line}`);
  const omitted = errors.length - shown.length;
  if (omitted <= 0) {
    return lines.join("\n");
  }
  return [
    ...lines,
    `- … and ${omitted} more runtime error(s) — run validate_app({ appId }) for the full list`,
  ].join("\n");
}
