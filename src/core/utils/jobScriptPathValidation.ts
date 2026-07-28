import { existsSync } from "fs";
import path from "path";

export type JobScriptPathSeverity = "error" | "warning";

export interface JobScriptPathIssue {
  rule: string;
  severity: JobScriptPathSeverity;
  message: string;
  remediation: string;
  suggestedCommand?: string;
}

const SCRIPT_JOB_TYPES = new Set(["python", "node"]);

function stripQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/** Minimal shell tokenization for job command script-path extraction. */
export function tokenizeShellCommand(command: string): string[] {
  return command.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g) ?? [];
}

/**
 * Extract the primary script path from a python/node job command.
 * Returns null for inline -c/-e, agent jobs, or unparseable commands.
 */
export function extractScriptPathFromCommand(
  jobType: string,
  command: string,
): string | null {
  if (!SCRIPT_JOB_TYPES.has(jobType)) {
    return null;
  }

  const tokens = tokenizeShellCommand(command.trim());
  if (tokens.length === 0) {
    return null;
  }

  if (jobType === "python") {
    const interpreterIdx = tokens.findIndex(
      (token) =>
        /^python3?$/.test(token) ||
        token.endsWith("/python3") ||
        token.endsWith("/python"),
    );
    if (interpreterIdx === -1) {
      return null;
    }

    for (let i = interpreterIdx + 1; i < tokens.length; i++) {
      const token = stripQuotes(tokens[i]);
      if (token === "-c") {
        return null;
      }
      if (token === "-m") {
        i += 1;
        continue;
      }
      if (token.startsWith("-")) {
        continue;
      }
      return token;
    }
    return null;
  }

  const nodeIdx = tokens.findIndex(
    (token) =>
      token === "node" ||
      token.endsWith("/node") ||
      token === "tsx" ||
      token.endsWith("/tsx"),
  );
  if (nodeIdx === -1) {
    return null;
  }

  for (let i = nodeIdx + 1; i < tokens.length; i++) {
    const token = stripQuotes(tokens[i]);
    if (token === "-e" || token === "--eval") {
      return null;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token;
  }

  return null;
}

function replaceScriptPathInCommand(
  command: string,
  oldPath: string,
  newPath: string,
): string {
  const quotedOld = oldPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<=\\s|^)${quotedOld}(?=\\s|$)`);
  if (pattern.test(command)) {
    return command.replace(pattern, newPath);
  }
  return command.replace(oldPath, newPath);
}

function suggestCommandWithCodePrefix(
  command: string,
  scriptPath: string,
): string {
  const basename = path.basename(scriptPath);
  const codePath = `code/${basename}`;
  return replaceScriptPathInCommand(command, scriptPath, codePath);
}

/** Assess whether a job command points at an on-disk script under the job directory. */
export async function assessJobScriptPath(
  jobType: string,
  command: string | undefined,
  jobDir: string,
  options?: { skipMissingFile?: boolean },
): Promise<JobScriptPathIssue[]> {
  if (!command?.trim() || !SCRIPT_JOB_TYPES.has(jobType)) {
    return [];
  }

  const scriptRel = extractScriptPathFromCommand(jobType, command);
  if (!scriptRel) {
    return [];
  }

  const issues: JobScriptPathIssue[] = [];
  const normalized = scriptRel.replace(/^\.\//, "");
  const isScriptFile = /\.(py|js|ts|mjs|cjs|jsx|tsx)$/i.test(normalized);

  if (isScriptFile && !normalized.startsWith("code/")) {
    issues.push({
      rule: "job-script-missing-code-prefix",
      severity: "warning",
      message: `Job command references "${normalized}" but Papr job scripts belong under code/ (e.g. code/${path.basename(normalized)}).`,
      remediation:
        "Place scripts in code/ and use python3 code/script.py or node code/script.js in the command.",
      suggestedCommand: suggestCommandWithCodePrefix(command, normalized),
    });
  }

  const commandPath = path.join(jobDir, normalized);
  if (existsSync(commandPath)) {
    return issues;
  }

  if (options?.skipMissingFile) {
    return issues;
  }

  const codePath = path.join(jobDir, "code", path.basename(normalized));
  const codeRel = `code/${path.basename(normalized)}`;

  if (existsSync(codePath) && normalized !== codeRel) {
    issues.push({
      rule: "job-script-wrong-location",
      severity: "error",
      message: `Command references "${normalized}" but the script exists at ${codeRel}.`,
      remediation: `update_job({ jobId, command: "... ${codeRel} ..." })`,
      suggestedCommand: replaceScriptPathInCommand(command, normalized, codeRel),
    });
    return issues;
  }

  issues.push({
    rule: "job-script-not-found",
    severity: "error",
    message: `Script "${normalized}" was not found under the job directory.`,
    remediation:
      "Create it under code/ (edit_job_file / write_file), list_job_files to verify, then update_job if the command path is wrong.",
  });

  return issues;
}

export function hasBlockingJobScriptPathIssues(
  issues: readonly JobScriptPathIssue[],
): boolean {
  return issues.some((issue) => issue.severity === "error");
}

export function buildJobScriptPathReminder(
  issues: readonly JobScriptPathIssue[],
): string | undefined {
  if (issues.length === 0) {
    return undefined;
  }

  const lines = issues.map((issue) => {
    const fix = issue.suggestedCommand
      ? ` Suggested command: ${issue.suggestedCommand}`
      : "";
    return `⚠️ ${issue.message} ${issue.remediation}${fix}`;
  });

  return lines.join("\n");
}

export function formatJobScriptPathBlockMessage(
  issues: readonly JobScriptPathIssue[],
): string {
  const blocking = issues.filter((issue) => issue.severity === "error");
  const header =
    blocking.length === 1
      ? "⛔ Cannot run job — script path preflight failed:"
      : `⛔ Cannot run job — ${blocking.length} script path error(s):`;

  return [
    header,
    ...blocking.map((issue) => `- [${issue.rule}] ${issue.message}`),
    "",
    "Fix with update_job (command path), move/create the script under code/, then run_job again.",
    "Use list_job_files to see what exists. Prefer read_job_logs over bash for debugging.",
  ].join("\n");
}
