/**
 * Guarded file search — shared by search_files and search_app_files.
 */

import fs from "fs/promises";
import { createReadStream } from "fs";
import readline from "readline";
import path from "path";
import { spawn } from "child_process";
import { getPaprAppsRoot, getPaprJobsRoot, getPaprRoot } from "../utils/paprRoot.js";
import { parseMiniAppIdFromAgentPath } from "../utils/paprAgentPaths.js";
import { formatPaprPathForAgent } from "../utils/paprAgentPaths.js";

/**
 * Files above this are skipped and REPORTED in `skipped` (never silently). Walk streams files
 * larger than SEARCH_STREAM_THRESHOLD_BYTES, so this only bounds the 30s wall budget.
 */
export const SEARCH_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Up to this size a file is read whole and split (fastest); larger files stream line by line. */
export const SEARCH_STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const SEARCH_MAX_SKIPPED_LISTED = 20;
export const SEARCH_MAX_FILES_SCANNED = 2000;
export const SEARCH_WALL_MS = 30_000;
export const SEARCH_MAX_DEPTH = 12;

/** Directory names skipped during walk (and via rg --glob). */
export const SEARCH_SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turso",
  ".venv",
  "venv",
  "__pycache__",
  ".versions",
  "coverage",
  ".cache",
  "target",
  ".pnpm-store",
  ".yarn",
]);

export type SearchTruncatedReason =
  | "max_results"
  | "max_files"
  | "timeout"
  | "max_depth";

export interface SearchMatch {
  file: string;
  line: number;
  content: string;
  match: string;
}

export interface FileSearchResult {
  path: string;
  query: string;
  matches: SearchMatch[];
  count: number;
  truncated: boolean;
  truncatedReason?: SearchTruncatedReason;
  filesScanned: number;
  elapsedMs: number;
  engine: "rg" | "walk";
  scopedFrom?: string;
  hint?: string;
  /** Files that were NOT searched (too large / unreadable). Absent when nothing was skipped. */
  skipped?: SearchSkippedFile[];
  /** Total skipped, including any beyond the listed SEARCH_MAX_SKIPPED_LISTED. */
  skippedCount?: number;
}

export interface SearchSkippedFile {
  file: string;
  reason: "too_large" | "unreadable";
  sizeBytes?: number;
}

export interface FileSearchOptions {
  searchPath: string;
  query: string;
  filePattern: string;
  caseSensitive: boolean;
  maxResults: number;
  /** When set, broad Papr paths scope to this mini-app. */
  appId?: string;
}

export interface PaprScopeAssessment {
  ok: boolean;
  resolvedPath?: string;
  blocked?: boolean;
  error?: string;
  autoScoped?: boolean;
  hint?: string;
}

const APP_ID_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAppIdSegment(segment: string): boolean {
  if (!segment || segment.includes(".")) {
    return false;
  }
  return APP_ID_UUID.test(segment) || /^[a-z0-9-]+$/i.test(segment);
}

function pathsEqual(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Block repo-wide Papr scans; optionally scope to one mini-app when appId is known.
 */
export function assessPaprSearchScope(
  searchPath: string,
  appId?: string,
): PaprScopeAssessment {
  const resolved = path.resolve(searchPath);
  const paprHome = path.resolve(getPaprRoot());
  const appsRoot = path.resolve(getPaprAppsRoot());
  const jobsRoot = path.resolve(getPaprJobsRoot());
  const trimmedAppId = appId?.trim();

  const scopeToApp = (baseLabel: string): PaprScopeAssessment => {
    if (!trimmedAppId) {
      return {
        ok: false,
        blocked: true,
        error:
          `Refusing to search all of ${baseLabel}. ` +
          `Use search_app_files({ appId, query }), ` +
          `search_agent_memory({ category: "code", projectId, query }), ` +
          `or bash: rg -n 'pattern' "$PAPR_HOME/apps/<appId>/"`,
      };
    }
    const scoped = path.join(appsRoot, trimmedAppId);
    return {
      ok: true,
      resolvedPath: scoped,
      autoScoped: true,
    };
  };

  if (pathsEqual(resolved, paprHome)) {
    return scopeToApp(formatPaprPathForAgent(paprHome));
  }
  if (pathsEqual(resolved, appsRoot)) {
    return scopeToApp(formatPaprPathForAgent(appsRoot));
  }
  if (pathsEqual(resolved, jobsRoot)) {
    return {
      ok: false,
      blocked: true,
      error:
        `Refusing to search all jobs at ${formatPaprPathForAgent(jobsRoot)}. ` +
        `Scope to one job directory, use search_agent_memory({ category: "code", projectId: "<jobId>", query }), ` +
        `or bash grep under that job folder.`,
    };
  }

  if (
    resolved.startsWith(appsRoot + path.sep) ||
    pathsEqual(resolved, appsRoot)
  ) {
    const rel = path.relative(appsRoot, resolved);
    const first = rel.split(path.sep)[0];
    if (!first || !isAppIdSegment(first)) {
      if (trimmedAppId) {
        return {
          ok: true,
          resolvedPath: path.join(appsRoot, trimmedAppId),
          autoScoped: true,
        };
      }
      return {
        ok: false,
        blocked: true,
        error:
          `Path is under Papr apps but not scoped to one app (${formatPaprPathForAgent(resolved)}). ` +
          `Pass appId or use search_app_files.`,
      };
    }
  }

  // Warn-style hint when path is huge but allowed (e.g. user repo outside Papr)
  const parsedApp = parseMiniAppIdFromAgentPath(resolved);
  if (!parsedApp && resolved.includes(`${path.sep}apps${path.sep}`)) {
    return { ok: true, resolvedPath: resolved, hint: "Prefer search_app_files when searching mini-app code." };
  }

  return { ok: true, resolvedPath: resolved };
}

let rgAvailable: boolean | null = null;

async function detectRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) {
    return rgAvailable;
  }
  return new Promise((resolve) => {
    const proc = spawn("rg", ["--version"], { stdio: "ignore" });
    proc.on("error", () => {
      rgAvailable = false;
      resolve(false);
    });
    proc.on("close", (code) => {
      rgAvailable = code === 0;
      resolve(rgAvailable);
    });
  });
}

function buildRipgrepGlobs(filePattern: string): string[] {
  const globs = [
    "!**/.git/**",
    "!**/node_modules/**",
    "!**/dist/**",
    "!**/build/**",
    "!**/.next/**",
    "!**/.venv/**",
    "!**/venv/**",
    "!**/__pycache__/**",
    "!**/.versions/**",
  ];
  if (filePattern && filePattern.length > 0) {
    globs.push(filePattern.startsWith("*") ? filePattern : `*${filePattern}`);
  }
  return globs;
}

async function searchWithRipgrep(
  options: FileSearchOptions,
  deadlineMs: number,
): Promise<FileSearchResult | null> {
  if (!(await detectRipgrep())) {
    return null;
  }

  const start = Date.now();
  const matches: SearchMatch[] = [];
  let truncated = false;
  let truncatedReason: SearchTruncatedReason | undefined;
  let searchedFiles: number | undefined;

  const args = [
    "--json",
    "--line-number",
    "--no-heading",
    "--color=never",
    "--max-filesize",
    `${SEARCH_MAX_FILE_BYTES}`,
    "--max-count",
    String(Math.max(1, options.maxResults)),
  ];
  if (!options.caseSensitive) {
    args.push("-i");
  }
  for (const glob of buildRipgrepGlobs(options.filePattern)) {
    args.push("--glob", glob);
  }
  args.push(options.query, options.searchPath);

  return new Promise((resolve) => {
    const proc = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      truncated = true;
      truncatedReason = "timeout";
    }, Math.max(1, deadlineMs - (Date.now() - start)));

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    proc.on("close", () => {
      clearTimeout(timer);
      const lines = stdout.split("\n").filter(Boolean);
      for (const raw of lines) {
        try {
          const row = JSON.parse(raw) as {
            type?: string;
            data?: {
              path?: { text?: string };
              line_number?: number;
              lines?: { text?: string };
              submatches?: Array<{ match?: { text?: string } }>;
              stats?: { searches?: number };
            };
          };
          if (row.type === "summary") {
            searchedFiles = row.data?.stats?.searches;
          }
          if (row.type !== "match" || !row.data?.path?.text) {
            continue;
          }
          const filePath = row.data.path.text;
          const lineNum = row.data.line_number ?? 0;
          const text = row.data.lines?.text?.trim() ?? "";
          const matchText =
            row.data.submatches?.[0]?.match?.text?.trim() ?? text.slice(0, 120);
          matches.push({
            file: filePath,
            line: lineNum,
            content: text,
            match: matchText,
          });
          if (matches.length >= options.maxResults) {
            truncated = true;
            truncatedReason = truncatedReason ?? "max_results";
            break;
          }
        } catch {
          // ignore non-json lines
        }
      }
      resolve({
        path: options.searchPath,
        query: options.query,
        matches,
        count: matches.length,
        truncated,
        truncatedReason,
        filesScanned: searchedFiles ?? matches.length,
        elapsedMs: Date.now() - start,
        engine: "rg",
      });
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export async function runGuardedFileSearch(
  options: FileSearchOptions,
): Promise<FileSearchResult | { blocked: true; error: string }> {
  const scope = assessPaprSearchScope(options.searchPath, options.appId);
  if (!scope.ok || scope.blocked) {
    return { blocked: true, error: scope.error ?? "Search path not allowed." };
  }

  const searchPath = scope.resolvedPath ?? options.searchPath;
  const deadline = Date.now() + SEARCH_WALL_MS;

  const rgResult = await searchWithRipgrep(
    { ...options, searchPath },
    deadline,
  );
  if (rgResult) {
    return {
      ...rgResult,
      scopedFrom: scope.autoScoped ? options.searchPath : undefined,
      hint: scope.hint,
    };
  }

  return searchWithWalk({ ...options, searchPath }, deadline, scope);
}

export async function searchWithWalk(
  options: FileSearchOptions,
  deadlineMs: number,
  scope: PaprScopeAssessment,
): Promise<FileSearchResult> {
  const start = Date.now();
  const matches: SearchMatch[] = [];
  let truncated = false;
  let truncatedReason: SearchTruncatedReason | undefined;
  let filesScanned = 0;

  let regex: RegExp;
  try {
    regex = new RegExp(options.query, options.caseSensitive ? "g" : "gi");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid search regex: ${message}`);
  }

  const filePatternRegex =
    options.filePattern && options.filePattern.length > 0
      ? new RegExp(
          options.filePattern.replace(/\*/g, ".*").replace(/\?/g, "."),
        )
      : null;

  const skipped: SearchSkippedFile[] = [];
  let skippedCount = 0;
  function noteSkip(file: string, reason: SearchSkippedFile["reason"], sizeBytes?: number): void {
    skippedCount += 1;
    if (skipped.length < SEARCH_MAX_SKIPPED_LISTED) {
      skipped.push({ file, reason, ...(sizeBytes !== undefined ? { sizeBytes } : {}) });
    }
  }

  /** True when scanning should stop (deadline hit or maxResults reached). */
  function checkLine(filePath: string, line: string, lineNo: number): boolean {
    if (Date.now() >= deadlineMs) {
      truncated = true;
      truncatedReason = truncatedReason ?? "timeout";
      return true;
    }
    const match = line.match(regex);
    if (!match) {
      return false;
    }
    matches.push({ file: filePath, line: lineNo, content: line.trim(), match: match[0] });
    if (matches.length >= options.maxResults) {
      truncated = true;
      truncatedReason = truncatedReason ?? "max_results";
      return true;
    }
    return false;
  }

  async function isBinary(filePath: string): Promise<boolean> {
    const handle = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, 4096, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  }

  async function searchInFile(filePath: string): Promise<void> {
    if (truncated || Date.now() >= deadlineMs) {
      return;
    }
    let size: number;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return;
      }
      size = stat.size;
    } catch {
      noteSkip(filePath, "unreadable");
      return;
    }
    if (size > SEARCH_MAX_FILE_BYTES) {
      noteSkip(filePath, "too_large", size);
      return;
    }
    filesScanned += 1;
    if (filesScanned > SEARCH_MAX_FILES_SCANNED) {
      truncated = true;
      truncatedReason = truncatedReason ?? "max_files";
      return;
    }

    try {
      if (size <= SEARCH_STREAM_THRESHOLD_BYTES) {
        const content = await fs.readFile(filePath, "utf8");
        if (content.slice(0, 4096).includes("\0")) {
          filesScanned -= 1; // like rg: binary files are not text-searched (not counted, not an error)
          return;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (checkLine(filePath, lines[i], i + 1)) {
            return;
          }
        }
        return;
      }
      if (await isBinary(filePath)) {
        filesScanned -= 1;
        return;
      }
      const stream = createReadStream(filePath, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let lineNo = 0;
      try {
        for await (const line of rl) {
          lineNo += 1;
          if (checkLine(filePath, line, lineNo)) {
            break;
          }
        }
      } finally {
        rl.close();
        stream.destroy();
      }
    } catch {
      noteSkip(filePath, "unreadable");
    }
  }

  async function scanDir(currentPath: string, depth: number): Promise<void> {
    if (truncated || Date.now() >= deadlineMs) {
      if (Date.now() >= deadlineMs) {
        truncated = true;
        truncatedReason = truncatedReason ?? "timeout";
      }
      return;
    }
    if (depth > SEARCH_MAX_DEPTH) {
      truncated = true;
      truncatedReason = truncatedReason ?? "max_depth";
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated || Date.now() >= deadlineMs) {
        return;
      }
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        await scanDir(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (filePatternRegex && !filePatternRegex.test(entry.name)) {
          continue;
        }
        await searchInFile(fullPath);
      }
    }
  }

  await scanDir(options.searchPath, 0);

  return {
    path: options.searchPath,
    query: options.query,
    matches,
    count: matches.length,
    truncated,
    truncatedReason,
    filesScanned,
    elapsedMs: Date.now() - start,
    engine: "walk",
    scopedFrom: scope.autoScoped ? options.searchPath : undefined,
    hint: skippedNote(scope.hint, skippedCount),
    ...(skippedCount > 0 ? { skipped, skippedCount } : {}),
  };
}

function skippedNote(hint: string | undefined, skippedCount: number): string | undefined {
  if (skippedCount === 0) {
    return hint;
  }
  const note =
    `${skippedCount} file(s) were NOT searched (too large or unreadable; see "skipped"). ` +
    `Zero matches does not cover them. Use bash grep/rg on those files, or read_file with offset/limit.`;
  return hint ? `${hint} ${note}` : note;
}
