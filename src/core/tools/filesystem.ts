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
import { resolveEditFileTarget } from "../utils/resolveEditFileTarget.js";

/** Resolve ~ and rewrite legacy ~/Papr/apps → active org/namespace paths (reads/searches). */
function expandPath(filePath: string): string {
  return resolvePaprAgentPath(filePath);
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

    // Check file size
    if (stats.size > maxSize) {
      const sizeKB = Math.round(stats.size / 1024);
      const maxKB = Math.round(maxSize / 1024);
      return {
        success: false,
        error: `File too large: ${sizeKB}KB (max ${maxKB}KB). Use bash with head/tail/grep, or read_file with offset/limit to read in chunks.`,
        type: "size_error",
      };
    }

    // Read file
    let content = await fs.readFile(filePath, encoding as BufferEncoding);

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

    const contentStr = content.toString();

    // Return content — cross-turn history keeps file reads full (toolResultTruncation.ts).
    // maxSize already caps disk reads; do not block here or the model never sees content.
    return {
      success: true,
      data: {
        path: filePath,
        content: contentStr,
        size: stats.size,
        encoding,
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
  path: z.string().describe("Directory to search in"),
  query: z.string().describe("Text to search for (regex supported)"),
  filePattern: z
    .string()
    .describe("File pattern (use empty string for all files)"),
  caseSensitive: z.boolean().describe("Whether search is case sensitive"),
  maxResults: z.number().describe("Maximum number of results"),
});

export type SearchFilesInput = z.infer<typeof SearchFilesSchema>;

export interface SearchMatch {
  file: string;
  line: number;
  content: string;
  match: string;
}

export interface SearchFilesOutput {
  path: string;
  query: string;
  matches: SearchMatch[];
  count: number;
  truncated: boolean;
}

async function searchFiles(
  input: SearchFilesInput,
): Promise<ToolResult<SearchFilesOutput>> {
  try {
    const {
      path: rawPath,
      query,
      filePattern,
      caseSensitive,
      maxResults,
    } = input;
    const searchPath = expandPath(rawPath);

    const regex = new RegExp(query, caseSensitive ? "g" : "gi");
    const matches: SearchMatch[] = [];
    let truncated = false;

    async function searchInFile(filePath: string): Promise<void> {
      if (matches.length >= maxResults) {
        truncated = true;
        return;
      }

      try {
        const content = await fs.readFile(filePath, "utf8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const match = line.match(regex);

          if (match) {
            matches.push({
              file: filePath,
              line: i + 1,
              content: line.trim(),
              match: match[0],
            });

            if (matches.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }

    async function scanDir(currentPath: string): Promise<void> {
      if (truncated) return;

      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        if (truncated) return;

        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile()) {
          // Check file pattern
          if (filePattern && filePattern.length > 0) {
            const regex = new RegExp(
              filePattern.replace(/\*/g, ".*").replace(/\?/g, "."),
            );
            if (!regex.test(entry.name)) continue;
          }

          await searchInFile(fullPath);
        }
      }
    }

    await scanDir(searchPath);

    return {
      success: true,
      data: {
        path: searchPath,
        query,
        matches,
        count: matches.length,
        truncated,
      },
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
    "Search for text in files (grep-like). Supports regex and file patterns.",
  inputSchema: SearchFilesSchema,
  execute: searchFiles,
});

// Export all filesystem tools
export const filesystemTools = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  searchFilesTool,
];
