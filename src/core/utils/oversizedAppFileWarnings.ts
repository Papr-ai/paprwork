/**
 * Reminders when large files are written into mini-app folders (git sync skips them).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getPaprRoot } from "./paprRoot.js";
import {
  describeOversizedSkip,
  formatGitSyncSizeLimitMb,
  isTooLargeForGitSync,
  MAX_GIT_SYNC_FILE_BYTES,
} from "../../gateway/services/cloudSync/gitSyncLimits.js";

const WRITE_COMMAND_PATTERN =
  /\b(cp|mv|install|tee|cat\s*>>|>\s*[^\s|&;]+|\bcurl\b[^\n|&;]*-o\b)/i;

export function isContentTooLargeForGitSync(content: string): boolean {
  return Buffer.byteLength(content, "utf8") > MAX_GIT_SYNC_FILE_BYTES;
}

export function buildLargeFileWriteReminder(relativePaths: readonly string[]): string {
  return (
    describeOversizedSkip(relativePaths) +
    "\nUse App Files (object storage) instead — read src/resources/agent-docs/APP_FILES_GUIDE.md."
  );
}

export function buildLargeContentWriteReminder(appRelativePath: string): string {
  return (
    `⚠️ This write is over ${formatGitSyncSizeLimitMb()} (${appRelativePath}) and will NOT sync to the web. ` +
    "Store large binaries with App Files (papr.files.upload in the app, papr_files.add in jobs). " +
    "Read src/resources/agent-docs/APP_FILES_GUIDE.md."
  );
}

function looksLikeAppFolderPath(candidate: string): boolean {
  return /(?:^|[/\\])apps[/\\]/i.test(candidate) || candidate.includes("/apps/");
}

export function looksLikeAppFolderWrite(command: string): boolean {
  return (
    WRITE_COMMAND_PATTERN.test(command) &&
    (looksLikeAppFolderPath(command) ||
      command.includes("$PAPR_HOME/apps/") ||
      command.includes("${PAPR_HOME}/apps/"))
  );
}

function expandPathCandidate(candidate: string, cwd: string, paprRoot: string): string {
  let expanded = candidate.replace(/^['"]|['"]$/g, "");
  if (expanded.includes("$PAPR_HOME")) {
    expanded = expanded.replace(/\$PAPR_HOME/g, paprRoot);
  }
  if (expanded.startsWith("~/")) {
    expanded = path.join(process.env.HOME ?? "", expanded.slice(2));
  }
  if (!path.isAbsolute(expanded)) {
    expanded = path.resolve(cwd, expanded);
  }
  return path.normalize(expanded);
}

function extractCandidatePaths(
  command: string,
  cwd: string,
  paprRoot: string,
): string[] {
  const results = new Set<string>();
  const tokens =
    command.match(
      /(?:\$PAPR_HOME\/[^\s;|&<>]+|~\/[^\s;|&<>]+|\/[^\s;|&<>]+|[A-Za-z0-9._-]+\/[^\s;|&<>]+)/g,
    ) ?? [];

  for (const token of tokens) {
    if (!looksLikeAppFolderPath(token)) {
      continue;
    }
    results.add(expandPathCandidate(token, cwd, paprRoot));
  }

  return [...results];
}

function toRepoRelative(absolutePath: string, paprRoot: string): string {
  const relative = path.relative(paprRoot, absolutePath).replace(/\\/g, "/");
  return relative.startsWith("..") ? absolutePath : relative;
}

export async function formatOversizedAppFileWarningBlock(
  command: string,
  cwd: string,
): Promise<string | undefined> {
  if (!looksLikeAppFolderWrite(command)) {
    return undefined;
  }

  const paprRoot = getPaprRoot();
  const candidates = extractCandidatePaths(command, cwd, paprRoot);
  const oversized: string[] = [];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && isTooLargeForGitSync(stat.size)) {
        oversized.push(toRepoRelative(candidate, paprRoot));
      }
    } catch {
      // Path missing or not a file — skip
    }
  }

  if (oversized.length === 0) {
    return undefined;
  }

  return `\n\n=== Large file warning ===\n${buildLargeFileWriteReminder(oversized)}`;
}

export function extractAppIdFromAppsPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/\/apps\/([0-9a-f-]{36})\//i);
  return match?.[1] ?? null;
}

export function buildAppRelativePath(
  absolutePath: string,
  appId: string,
): string | null {
  const normalized = absolutePath.replace(/\\/g, "/");
  const marker = `/apps/${appId}/`;
  const index = normalized.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) {
    return null;
  }
  return normalized.slice(index + marker.length);
}
