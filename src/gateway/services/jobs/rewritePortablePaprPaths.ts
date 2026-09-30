/**
 * Rewrite machine-specific Papr paths to portable env vars ($JOB_DIR, $JOB_DB, $PAPR_HOME).
 * Used after flat → namespace migration and by offline repair scripts.
 */

import { normalizePortableJobPrompt } from "./normalizePortableJobPrompt.js";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Prefix for a Papr Jobs folder (flat ~/Papr or org/namespace layout).
 * Captures through Jobs/{jobId} but not trailing path segments.
 */
function buildJobDirectoryPrefixPattern(jobId: string): string {
  const id = escapeRegex(jobId);
  return (
    `(?:~\\/Papr|\\/Users\\/[^\\s"'\\\`]+\\/Papr)` +
    `(?:\\/orgs\\/[^/\\s"'\\\`]+\\/namespaces\\/[^/\\s"'\\\`]+)?` +
    `\\/(?:Jobs|jobs)\\/${id}`
  );
}

function rewriteSameJobPaths(text: string, jobId: string): string {
  const prefix = buildJobDirectoryPrefixPattern(jobId);

  let result = text.replace(
    new RegExp(`${prefix}\\/data\\/data\\.db`, "gi"),
    "$JOB_DB",
  );

  result = result.replace(new RegExp(prefix, "gi"), "$JOB_DIR");

  const normalizedJobId = escapeRegex(jobId);
  result = result.replace(
    new RegExp(
      `\\$PAPR_HOME\\/(?:Jobs|jobs)\\/${normalizedJobId}\\/data\\/data\\.db`,
      "gi",
    ),
    "$JOB_DB",
  );
  result = result.replace(
    new RegExp(
      `\\$PAPR_HOME\\/(?:Jobs|jobs)\\/${normalizedJobId}(?=\\/|"|'|\\s|$|\`)`,
      "gi",
    ),
    "$JOB_DIR",
  );

  return result;
}

/** True when text still contains paths this repair pass can fix. */
export function containsRepairablePaprPaths(text: string): boolean {
  return (
    /(?:\$HOME\/Papr\/(?:Jobs|jobs|data|apps|workspace|Chats|orgs)|~\/Papr\/(?:Jobs|jobs|data|apps|workspace|Chats|orgs)|\/Users\/[^\s"'`]+?\/Papr\/)/i.test(
      text,
    ) || /~\/\.paprwork-v2\//i.test(text)
  );
}

export interface RewritePortablePaprPathsResult {
  text: string;
  changed: boolean;
}

/**
 * Rewrite hardcoded Papr paths in job commands, prompts, or source files.
 * When jobId is set, paths for that job prefer $JOB_DIR / $JOB_DB.
 */
export function rewritePortablePaprPaths(
  text: string,
  jobId?: string,
): RewritePortablePaprPathsResult {
  if (!text || !containsRepairablePaprPaths(text)) {
    return { text, changed: false };
  }

  let result = text;
  if (jobId) {
    result = rewriteSameJobPaths(result, jobId);
  }
  result = normalizePortableJobPrompt(result);

  return {
    text: result,
    changed: result !== text,
  };
}
