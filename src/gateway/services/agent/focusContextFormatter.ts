/**
 * Format UI focus + recent edits as a volatile user message (prompt-cache safe).
 */

import type {
  ResolvedAgentFocusContext,
  UiAgentFocusContext,
} from "../../../core/types/agentFocus.js";

/** Prefix for injected focus context (context inspector + mid-turn trim). */
export const AGENT_FOCUS_CONTEXT_PREFIX =
  "[FOCUS CONTEXT - Active mini-app and recent edits]";

const MAX_LAST_EDITED = 5;
const MAX_APP_FILES_LISTED = 24;
const MAX_JOB_FILES_LISTED = 24;

export function formatAgentFocusContext(
  resolved: ResolvedAgentFocusContext | undefined,
): string | undefined {
  if (!resolved) return undefined;

  const hasActiveApp = Boolean(resolved.activeApp?.appId);
  const hasActiveJob = Boolean(resolved.activeJob?.jobId);
  const hasLastEdited =
    Array.isArray(resolved.lastEdited) && resolved.lastEdited.length > 0;

  if (!hasActiveApp && !hasActiveJob && !hasLastEdited) {
    return undefined;
  }

  const sections: string[] = [];

  if (hasActiveApp && resolved.activeApp) {
    const { appId, title, files } = resolved.activeApp;
    const fileLines =
      files && files.length > 0
        ? files
            .slice(0, MAX_APP_FILES_LISTED)
            .map((f) => `  - ${f}`)
            .join("\n")
        : "  (file list unavailable)";

    sections.push(`## Active mini-app (user has this open in the UI)

- **Title:** ${title}
- **appId:** \`${appId}\`
- **Files:**
${fileLines}

**Use this app for edits** unless the user names a different app. Skip \`list_apps\` / \`list_app_files\` when the target file is listed above. **Do not bulk \`read_app_file\` the whole app** — use edit history + \`postEditSnippet\` in prior edit results, or re-read **only** specific files you need to debug.

**Trivial tweak** (one color, label, class): \`edit_app_file({ appId: "${appId}", filename: "<filename>", oldString, newString })\` — auto-runs esbuild + validation; follow \`_verifyReminder\`; no plan for one-line changes.`);
  }

  if (hasActiveJob && resolved.activeJob) {
    const { jobId, name, files } = resolved.activeJob;
    const fileLines =
      files && files.length > 0
        ? files
            .slice(0, MAX_JOB_FILES_LISTED)
            .map((f) => `  - ${f}`)
            .join("\n")
        : "  (file list unavailable)";

    sections.push(`## Active job (user has this selected in the Jobs UI)

- **Name:** ${name}
- **jobId:** \`${jobId}\`
- **Files:**
${fileLines}

**Use this job for edits** unless the user names a different job. Skip \`list_jobs\` / \`list_job_files\` when the target file is listed above.

**Trivial script tweak:** \`edit_file({ path: "<jobDir>/{filename}", oldString, newString })\` (use \`dir\` from \`list_jobs\`) — then \`run_job\` to verify; no plan unless logic or schedule changes.`);
  }

  if (hasLastEdited && resolved.lastEdited) {
    const lines = resolved.lastEdited
      .slice(0, MAX_LAST_EDITED)
      .map((entry) => {
        const when = new Date(entry.editedAt).toISOString();
        if (entry.kind === "mini_app") {
          return `- mini-app \`${entry.appId}\` / \`${entry.filename ?? entry.path}\` (${when})`;
        }
        if (entry.kind === "job") {
          return `- job \`${entry.jobId}\` / \`${entry.filename ?? entry.path}\` (${when})`;
        }
        const repo = entry.repoRoot ? ` repo \`${entry.repoRoot}\`` : "";
        return `- repo file \`${entry.path}\`${repo} (${when})`;
      })
      .join("\n");

    sections.push(`## Recently edited files (this session)

${lines}

Prefer these paths for follow-up edits. Edit tool results include a \`postEditSnippet\` of the changed region — **skip re-reading** those files unless debugging a specific issue. Re-read **only** files from this list that you must verify, not the entire app. Use \`edit_file({ path, oldString, newString })\` — mini-app paths auto-run esbuild; external repo paths auto-stage in git.`);
  }

  return `${AGENT_FOCUS_CONTEXT_PREFIX}

${sections.join("\n\n")}`;
}

export function mergeUiAndServerFocus(
  ui: UiAgentFocusContext | undefined,
  server: ResolvedAgentFocusContext | undefined,
): ResolvedAgentFocusContext | undefined {
  const activeApp = ui?.activeApp ?? server?.activeApp;
  const activeJob = ui?.activeJob ?? server?.activeJob;
  const lastEdited = server?.lastEdited;

  if (
    !activeApp &&
    !activeJob &&
    (!lastEdited || lastEdited.length === 0)
  ) {
    return undefined;
  }

  return {
    ...(activeApp ? { activeApp } : {}),
    ...(activeJob ? { activeJob } : {}),
    ...(lastEdited && lastEdited.length > 0 ? { lastEdited } : {}),
  };
}
