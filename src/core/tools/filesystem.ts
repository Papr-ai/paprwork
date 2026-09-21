/**
 * Filesystem Tool - File operations with safety
 *
 * Provides:
 * - Read files (with encoding support)
 * - Write/append files (with backups)
 * - List directories (with filtering)
 * - Search files (grep-like functionality)
 * - File info (stats, permissions)
 */

import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import type { ToolResult } from "../types/tools.js";
import { autoStageFile } from "../utils/gitAutoStage.js";
import {
  getLegacyPaprMisrouteBlockReason,
  resolvePaprAgentPath,
} from "../utils/paprAgentPaths.js";
import { resolveBundledResourceReadPath } from "../utils/resolveBundledResourcePath.js";
import { resolveEditFileTarget } from "../utils/resolveEditFileTarget.js";
import { getActiveAppIdForTools } from "./context.js";
import {
  runGuardedFileSearch,
  type FileSearchResult,
  type SearchMatch,
} from "./fileSearch.js";
import { getPaprAppsRoot } from "../utils/paprRoot.js";

/** Resolve ~, Papr workspace paths, and cloud bundled agent-docs (src/resources → dist/resources). */
function expandPath(filePath: string): string {
  return resolveBundledResourceReadPath(resolvePaprAgentPath(filePath));
}

// ========================================
// Read File
// ========================================

const ReadFileSchema = z.object({
  path: z.string().describe("Path to file to read"),
  encoding: z
    .enum(["utf8", "base64", "binary"])
    .default("utf8")
    .describe("File encoding (default: utf8)"),
  maxSize: z
    .number()
    .default(50000)
    .describe(
      "Max file size in bytes (default: 50KB). For large files, use bash with head/tail/grep instead.",
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Start reading from line N (1-indexed). Use to read specific portions of large files.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Read only N lines. Use with offset to read file in chunks."),
});

export type ReadFileInput = z.infer<typeof ReadFileSchema>;

export interface ReadFileOutput {
  path: string;
  content: string;
  size: number;
  encoding: string;
  /** True when only the first maxSize bytes were returned for an oversized file. */
  truncated?: boolean;
}

async function readFile(
  input: ReadFileInput,
): Promise<ToolResult<ReadFileOutput>> {
  try {
    const { path: rawPath, encoding, maxSize, offset, limit } = input;
    const filePath = expandPath(rawPath);

    // Check if file exists
    const stats = await fs.stat(filePath);

    if (!stats.isFile()) {
      return {
        success: false,
        error: `Path is not a file: ${filePath}`,
        type: "validation_error",
      };
    }

    // Read file (partial when oversized and no line-based slice requested)
    let content: string | Buffer;
    let truncated = false;
    if (
      stats.size > maxSize &&
      offset === undefined &&
      limit === undefined
    ) {
      const handle = await fs.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(maxSize);
        const { bytesRead } = await handle.read(buffer, 0, maxSize, 0);
        content =
          encoding === "utf8"
            ? buffer.subarray(0, bytesRead).toString("utf8")
            : buffer.subarray(0, bytesRead);
        truncated = true;
      } finally {
        await handle.close();
      }
    } else if (stats.size > maxSize) {
      const sizeKB = Math.round(stats.size / 1024);
      const maxKB = Math.round(maxSize / 1024);
      return {
        success: false,
        error: `File too large: ${sizeKB}KB (max ${maxKB}KB). Use read_file with offset/limit for line chunks, or bash head/tail for byte ranges.`,
        type: "size_error",
      };
    } else {
      content = await fs.readFile(filePath, encoding as BufferEncoding);
    }

    // Apply line-based offset/limit if requested
    if (offset !== undefined || limit !== undefined) {
      const lines = content.toString().split("\n");
      const startLine = (offset ?? 1) - 1; // Convert to 0-indexed
      const endLine = limit !== undefined ? startLine + limit : undefined;
      const selectedLines = lines.slice(startLine, endLine);
      content = selectedLines.join("\n") as any;

      // Add metadata about what was read
      const totalLines = lines.length;
      const readLines = selectedLines.length;
      const metadata = `\n\n[Read lines ${offset ?? 1}-${(offset ?? 1) + readLines - 1} of ${totalLines} total lines]`;
      content = (content + metadata) as any;
    }

    let contentStr = content.toString();
    if (truncated) {
      const sizeKB = Math.round(stats.size / 1024);
      const maxKB = Math.round(maxSize / 1024);
      contentStr +=
        `\n\n[Partial read: first ${maxKB}KB of ${sizeKB}KB total. ` +
        `Use bash head/tail or read_file offset/limit for more.]`;
    }

    // Return content — cross-turn history keeps file reads full (toolResultTruncation.ts).
    // maxSize already caps disk reads; do not block here or the model never sees content.
    return {
      success: true,
      data: {
        path: filePath,
        content: contentStr,
        size: stats.size,
        encoding,
        ...(truncated ? { truncated: true } : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to read file: ${message}`,
      type: "read_error",
    };
  }
}

// ========================================
// Write File
// ========================================

const WriteFileSchema = z.object({
  path: z.string().describe("Path to file to write"),
  content: z.string().describe("Content to write"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("File encoding"),
  backup: z.boolean().default(false).describe("Create backup if file exists"),
  createDirs: z.boolean().default(true).describe("Create parent directories"),
});

export type WriteFileInput = z.infer<typeof WriteFileSchema>;

export interface WriteFileOutput {
  path: string;
  size: number;
  backed_up: boolean;
  backup_path?: string;
  git_staged?: boolean;
  git_status?: string;
}

async function writeFile(
  input: WriteFileInput,
): Promise<ToolResult<WriteFileOutput>> {
  try {
    const { path: rawPath, content, encoding, backup, createDirs } = input;
    const expanded = expandPath(rawPath);

    const legacyMisroute = getLegacyPaprMisrouteBlockReason(expanded);
    if (legacyMisroute) {
      return {
        success: false,
        error: legacyMisroute,
        type: "legacy_papr_path_guard",
      };
    }

    const filePath = expanded;

    const editTarget = resolveEditFileTarget(filePath);
    if (editTarget.kind === "blocked") {
      return {
        success: false,
        error: editTarget.reason,
        type: "mini_app_edit_guard",
      };
    }

    if (editTarget.kind === "mini_app") {
      const { runWriteAppFile } = await import("./appJobs.js");
      const miniAppResult = await runWriteAppFile({
        appId: editTarget.appId,
        filename: editTarget.filename,
        content,
      });
      return {
        success: miniAppResult.success,
        data: {
          path: filePath,
          appId: editTarget.appId,
          size: Buffer.byteLength(content, encoding as BufferEncoding),
          backed_up: false,
          ...miniAppResult.data,
        },
        error: miniAppResult.error,
        type: miniAppResult.success ? undefined : "mini_app_validation_error",
        _verifyReminder: miniAppResult._verifyReminder,
        _emojiReminder: miniAppResult._emojiReminder,
        ...(miniAppResult._backendKeysReminder
          ? { _backendKeysReminder: miniAppResult._backendKeysReminder }
          : {}),
        ...(miniAppResult._jobEventsReminder
          ? { _jobEventsReminder: miniAppResult._jobEventsReminder }
          : {}),
        ...(miniAppResult._largeFileReminder
          ? { _largeFileReminder: miniAppResult._largeFileReminder }
          : {}),
      } as unknown as ToolResult<WriteFileOutput>;
    }

    // Create parent directories if needed
    if (createDirs) {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
    }

    // Create backup if file exists
    let backed_up = false;
    let backup_path: string | undefined;

    if (backup) {
      try {
        await fs.access(filePath);
        // File exists, create backup
        backup_path = `${filePath}.backup.${Date.now()}`;
        await fs.copyFile(filePath, backup_path);
        backed_up = true;
      } catch {
        // File doesn't exist, no backup needed
      }
    }

    // Write file
    let isNewFile = false;
    try {
      await fs.access(filePath);
    } catch {
      isNewFile = true;
    }

    await fs.writeFile(filePath, content, encoding as BufferEncoding);

    // Get size
    const stats = await fs.stat(filePath);

    // Auto-stage file in git if in a repo
    const gitResult = await autoStageFile(filePath);

    if (isNewFile) {
      void import("../../gateway/services/wikiLocalEntityGraphSync.js")
        .then(({ syncWikiEntityFileToGraph }) =>
          syncWikiEntityFileToGraph({
            filePath,
            content,
            source: "write_file",
          }),
        )
        .catch(() => {
          // Best-effort — entity graph sync must not block writes
        });
    }

    try {
      const { getAgentFocusContextService } = await import(
        "../../gateway/services/AgentFocusContextService.js"
      );
      getAgentFocusContextService().recordAbsolutePathEdit(filePath);
    } catch {
      // Focus tracking is best-effort
    }

    const {
      extractAppIdFromAppsPath,
      buildAppRelativePath,
      buildLargeContentWriteReminder,
      buildLargeFileWriteReminder,
    } = await import("../utils/oversizedAppFileWarnings.js");
    const { isTooLargeForGitSync } = await import(
      "../../gateway/services/cloudSync/gitSyncLimits.js"
    );

    let largeFileReminder: string | undefined;
    const appIdFromPath = extractAppIdFromAppsPath(filePath);
    if (appIdFromPath && isTooLargeForGitSync(stats.size)) {
      const appRelative = buildAppRelativePath(filePath, appIdFromPath);
      largeFileReminder = appRelative
        ? buildLargeContentWriteReminder(appRelative)
        : buildLargeFileWriteReminder([filePath]);
    }

    return {
      success: true,
      data: {
        path: filePath,
        size: stats.size,
        backed_up,
        backup_path,
        git_staged: gitResult.staged,
        git_status: gitResult.staged ? "staged" : "untracked",
      },
      ...(largeFileReminder ? { _largeFileReminder: largeFileReminder } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to write file: ${message}`,
      type: "write_error",
    };
  }
}

// ========================================
// List Directory
// ========================================

const ListDirectorySchema = z.object({
  path: z.string().describe("Path to directory"),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to scan recursively"),
  pattern: z
    .string()
    .optional()
    .default("")
    .describe("Glob pattern to filter files (use empty string for no filter)"),
  maxDepth: z
    .number()
    .optional()
    .default(3)
    .describe("Max recursion depth when recursive is true"),
});

export type ListDirectoryInput = z.infer<typeof ListDirectorySchema>;

export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modified: string;
}

export interface ListDirectoryOutput {
  path: string;
  files: FileInfo[];
  count: number;
}

async function listDirectory(
  input: ListDirectoryInput,
): Promise<ToolResult<ListDirectoryOutput>> {
  try {
    const { path: rawPath, recursive, pattern, maxDepth } = input;
    const dirPath = expandPath(rawPath);

    // Check if directory exists
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      return {
        success: false,
        error: `Path is not a directory: ${dirPath}`,
        type: "validation_error",
      };
    }

    const files: FileInfo[] = [];

    async function scanDir(
      currentPath: string,
      depth: number = 0,
    ): Promise<void> {
      if (depth > maxDepth) return;

      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const stats = await fs.stat(fullPath);

        // Check pattern match
        if (pattern && pattern.length > 0) {
          const regex = new RegExp(
            pattern.replace(/\*/g, ".*").replace(/\?/g, "."),
          );
          if (!regex.test(entry.name)) {
            continue;
          }
        }

        const fileInfo: FileInfo = {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory()
            ? "directory"
            : entry.isSymbolicLink()
              ? "symlink"
              : "file",
          size: stats.size,
          modified: stats.mtime.toISOString(),
        };

        files.push(fileInfo);

        // Recurse into directories
        if (recursive && entry.isDirectory()) {
          await scanDir(fullPath, depth + 1);
        }
      }
    }

    await scanDir(dirPath);

    return {
      success: true,
      data: {
        path: dirPath,
        files,
        count: files.length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to list directory: ${message}`,
      type: "read_error",
    };
  }
}

// ========================================
// Search Files
// ========================================

const SearchFilesSchema = z.object({
  path: z
    .string()
    .describe(
      "Directory to search. Do NOT pass $PAPR_HOME, all of apps/, or all Jobs/ — use search_app_files or bash rg on one app/job.",
    ),
  query: z.string().describe("Text to search for (regex supported)"),
  filePattern: z
    .string()
    .describe("File pattern such as *.ts (use empty string for all files)"),
  caseSensitive: z.boolean().describe("Whether search is case sensitive"),
  maxResults: z.number().describe("Maximum number of results"),
  appId: z
    .string()
    .optional()
    .describe(
      "Optional mini-app id — auto-scopes broad Papr paths to $PAPR_HOME/apps/{appId}/",
    ),
});

export type SearchFilesInput = z.infer<typeof SearchFilesSchema>;

export type { SearchMatch };

export interface SearchFilesOutput extends FileSearchResult {}

function fileSearchResultToToolData(result: FileSearchResult): SearchFilesOutput {
  return result;
}

async function executeGuardedSearch(
  searchPath: string,
  input: Pick<
    SearchFilesInput,
    "query" | "filePattern" | "caseSensitive" | "maxResults" | "appId"
  >,
): Promise<ToolResult<SearchFilesOutput>> {
  try {
    const appId = input.appId?.trim() || getActiveAppIdForTools();
    const outcome = await runGuardedFileSearch({
      searchPath,
      query: input.query,
      filePattern: input.filePattern,
      caseSensitive: input.caseSensitive,
      maxResults: input.maxResults,
      appId,
    });

    if ("blocked" in outcome) {
      return {
        success: false,
        error: outcome.error,
        type: "search_error",
      };
    }

    return {
      success: true,
      data: fileSearchResultToToolData(outcome),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to search files: ${message}`,
      type: "search_error",
    };
  }
}

async function searchFiles(
  input: SearchFilesInput,
): Promise<ToolResult<SearchFilesOutput>> {
  const searchPath = expandPath(input.path);
  return executeGuardedSearch(searchPath, input);
}

export const SearchAppFilesSchema = z.object({
  appId: z.string().describe("Mini-app id (UUID from list_apps or focus context)"),
  query: z.string().describe("Text to search for (regex supported)"),
  filePattern: z
    .string()
    .describe("File pattern such as *.tsx (empty string = all files)"),
  caseSensitive: z.boolean().describe("Whether search is case sensitive"),
  maxResults: z.number().describe("Maximum number of match lines to return"),
});

export type SearchAppFilesInput = z.infer<typeof SearchAppFilesSchema>;

async function searchAppFiles(
  input: SearchAppFilesInput,
): Promise<ToolResult<SearchFilesOutput>> {
  const appRoot = path.join(getPaprAppsRoot(), input.appId.trim());
  return executeGuardedSearch(appRoot, input);
}

// ========================================
// Tool Definitions
// ========================================

export const readFileTool = createTool({
  id: "read_file",
  description:
    "Read file contents (max 50KB default). For large files: use offset/limit to read chunks, or bash with head/tail/grep for targeted reading. Supports UTF-8, base64, and binary encodings.",
  inputSchema: ReadFileSchema,
  execute: readFile,
});

export const writeFileTool = createTool({
  id: "write_file",
  description:
    "Write content to a file. OVERWRITES existing files in place — you do NOT need to delete a file before recreating it. " +
    "Creates parent directories if needed. Creates backup if specified. " +
    "For $PAPR_HOME/apps/{appId}/… paths: creates or overwrites mini-app files and auto-runs esbuild + validate_app (same as edit_file). " +
    "Use edit_file for surgical patches (oldString/newString); use write_file to create new mini-app files or replace a whole file. " +
    "ANTI-PATTERN: Never run `rm <file>` followed by `write_file({ path: <file> })` in the same turn — if the stream is interrupted between the two, the file is lost. Just call write_file directly; it overwrites.",
  inputSchema: WriteFileSchema,
  execute: writeFile,
});

export const listDirectoryTool = createTool({
  id: "list_directory",
  description:
    "List files and directories. Supports recursive listing and pattern filtering.",
  inputSchema: ListDirectorySchema,
  execute: listDirectory,
});

export const searchFilesTool = createTool({
  id: "search_files",
  description:
    "Slow grep-like search over a directory tree (30s max, skips node_modules/dist/venv). " +
    "For Papr mini-apps prefer search_app_files or bash rg on $PAPR_HOME/apps/{appId}/. " +
    "For meaning-based code discovery prefer search_agent_memory({ category: \"code\", projectId, query }). " +
    "Refuses whole $PAPR_HOME, apps/, or Jobs/ roots.",
  inputSchema: SearchFilesSchema,
  execute: searchFiles,
});

export const searchAppFilesTool = createTool({
  id: "search_app_files",
  description:
    "Search text under one mini-app directory ($PAPR_HOME/apps/{appId}/). " +
    "Uses ripgrep when available. Prefer search_agent_memory for semantic code search; use this for exact symbol matches.",
  inputSchema: SearchAppFilesSchema,
  execute: searchAppFiles,
});

// Export all filesystem tools
export const filesystemTools = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  searchFilesTool,
  searchAppFilesTool,
];
