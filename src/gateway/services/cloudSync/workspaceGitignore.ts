/**
 * Workspace .gitignore maintenance for Papr cloud sync.
 *
 * Mini-app apps/{id}/dist must be tracked (cloud host serves dist/app.js) while
 * all other dist folders stay ignored. Older workspaces often have a global dist
 * ignore without negation rules — patch them on startup and force-add on push.
 */

import fs from "node:fs";
import path from "node:path";

export const MINI_APP_DIST_GITIGNORE_EXCEPTIONS = [
  "# Published mini-apps NEED dist in git — apps.papr.ai serves the bundled",
  "# dist/app.js (built at publish time) instead of 20+ individual TS modules.",
  "!apps/*/dist/",
  "!apps/*/dist/**",
] as const;

export const LOCAL_SYNC_STATE_GITIGNORE_LINES = [
  "data/.db-memory-sync-state.json",
  "data/.turso-convergence-state.json",
  "data/.legacy-home-job-migration.json",
  "data/.gateway-sync-busy.json",
] as const;

const JOB_RUNTIME_GITIGNORE_LINES = [
  "Jobs/*/job.runtime.json",
  "data/job-runs.jsonl",
  "**/*.sync-backup-*",
] as const;

/** True when git will un-ignore published mini-app dist bundles. */
export function hasMiniAppDistGitignoreExceptions(content: string): boolean {
  return (
    content.includes("!apps/*/dist/") || content.includes("!apps/*/dist/**")
  );
}

/** Repo-relative mini-app dist directories that exist and should be force-staged. */
export function miniAppDistRelativePaths(
  paprDir: string,
  appIds: readonly string[],
): string[] {
  const paths: string[] = [];
  for (const appId of appIds) {
    if (!appId || appId.includes("/") || appId.includes("..")) {
      continue;
    }
    const rel = path.join("apps", appId, "dist");
    if (fs.existsSync(path.join(paprDir, rel))) {
      paths.push(rel.replace(/\\/g, "/"));
    }
  }
  return paths;
}

/**
 * Append missing Papr cloud-sync gitignore rules to an existing workspace file.
 */
export function patchWorkspaceGitignore(existing: string): string {
  let content = existing.trimEnd();
  const blocks: string[][] = [];

  if (!hasMiniAppDistGitignoreExceptions(content)) {
    blocks.push([...MINI_APP_DIST_GITIGNORE_EXCEPTIONS]);
  }

  const missingLocalSync = LOCAL_SYNC_STATE_GITIGNORE_LINES.filter(
    (line) => !content.includes(line),
  );
  if (missingLocalSync.length > 0) {
    blocks.push(["# Local sync state — never in git", ...missingLocalSync]);
  }

  const missingRuntime = JOB_RUNTIME_GITIGNORE_LINES.filter(
    (line) => !content.includes(line),
  );
  if (missingRuntime.length > 0) {
    blocks.push([
      "# Job runtime — local + memory heartbeat only, never git",
      "Jobs/*/job.runtime.json",
      "data/job-runs.jsonl",
      "# Turso sync safety snapshots — local only",
      "**/*.sync-backup-*",
    ]);
  }

  if (blocks.length === 0) {
    return existing.endsWith("\n") ? existing : `${existing}\n`;
  }

  for (const block of blocks) {
    content = `${content}\n\n${block.join("\n")}`;
  }
  return `${content}\n`;
}

export function patchWorkspaceGitignoreIfNeeded(existing: string): {
  content: string;
  changed: boolean;
} {
  const content = patchWorkspaceGitignore(existing);
  return { content, changed: content !== existing };
}
