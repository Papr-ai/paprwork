/**
 * Workspace .gitignore maintenance for Papr cloud sync.
 *
 * Mini-app apps/{id}/dist must be tracked (cloud host serves dist/app.js) while
 * all other dist folders stay ignored. Older workspaces often have a global dist
 * ignore without negation rules — patch them on startup and force-add on push.
 */

import fs from "node:fs";
import path from "node:path";
import { STATE_FILENAME } from "./syncState.js";

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

/** Default `.gitignore` for a fresh Papr cloud-sync workspace. */
export function buildDefaultWorkspaceGitignore(): string {
  return `# Runtime — rebuilt per environment
**/venv/
**/.venv/
**/node_modules/
**/__pycache__/
**/dist/
${MINI_APP_DIST_GITIGNORE_EXCEPTIONS.join("\n")}
**/.versions/

# SQLite — synced via Turso, not git
**/*.db
**/*.db-wal
**/*.db-shm
**/*.sqlite
**/*.sqlite3

# Backups — local disaster-recovery artifacts. These are snapshots of data that
# is already synced (Turso for SQLite, git for code), so committing them stores
# a second, uncompressible copy of everything. Keep them OUT of the sync tree.
**/*.bak
**/*.bak.*
backups/
**/backups/

# Archives — migration tarballs and exports are large, opaque, and regenerable
**/*.tgz
**/*.tar.gz
**/*.zip

# Audio / recordings — runtime blobs (not git). Store metadata in job data.db
# (Turso sync); large files belong in object storage (bucket), not GitHub.
**/*.wav
**/*.m4a
**/*.mp3
**/*.aiff
**/*.caf
**/*.flac
**/*.webm
# Match the directory at ANY depth, not just under data/. Extension rules alone
# are fragile — a future encoder change would silently start committing again.
recordings/
**/recordings/

# Backup / corrupt recovery artifacts — local only (Turso repair, index recovery)
**/*.bak
**/*.bak.*
**/*.backup.*
**/*.backup-*
**/*.sync-backup-*
**/*.corrupt-*
**/*corrupt-backup*

# Local sync state — never in git
${LOCAL_SYNC_STATE_GITIGNORE_LINES.join("\n")}

# Logs — ephemeral
**/logs/
**/*.log

# Secrets — never in git
.env
*.pem
*.key

# Large runtime artifacts
**/chrome-profile/

# OS files
**/.DS_Store

# Sync state (local only — machine-specific Turso cursors)
${STATE_FILENAME}
data/.turso-sync-state.json

# Job runtime — local + memory heartbeat only, never git
Jobs/*/job.runtime.json
data/job-runs.jsonl
`;
}

/** Create or patch workspace `.gitignore` for cloud sync rules. */
export function ensureWorkspaceGitignore(paprDir: string): void {
  const gitignorePath = path.join(paprDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, buildDefaultWorkspaceGitignore(), "utf-8");
    return;
  }
  const existing = fs.readFileSync(gitignorePath, "utf-8");
  const { content, changed } = patchWorkspaceGitignoreIfNeeded(existing);
  if (changed) {
    fs.writeFileSync(gitignorePath, content, "utf-8");
  }
}
