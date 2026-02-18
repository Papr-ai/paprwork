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
import os from "os";
import path from "path";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import type { ToolResult } from "../types/tools.js";

/** Expand a leading `~` to the user's home directory. */
function expandPath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

// ========================================
// Read File
// ========================================

const ReadFileSchema = z.object({
  path: z.string().describe("Path to file to read"),
  encoding: z.enum(["utf8", "base64", "binary"]).describe("File encoding"),
  maxSize: z.number().describe("Max file size in bytes"),
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
    const { path: rawPath, encoding, maxSize } = input;
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
      return {
        success: false,
        error: `File too large: ${stats.size} bytes (max ${maxSize})`,
        type: "size_error",
      };
    }

    // Read file
    const content = await fs.readFile(filePath, encoding as BufferEncoding);

    return {
      success: true,
      data: {
        path: filePath,
        content: content.toString(),
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
  encoding: z.enum(["utf8", "base64"]).describe("File encoding"),
  backup: z.boolean().describe("Create backup if file exists"),
  createDirs: z.boolean().describe("Create parent directories"),
});

export type WriteFileInput = z.infer<typeof WriteFileSchema>;

export interface WriteFileOutput {
  path: string;
  size: number;
  backed_up: boolean;
  backup_path?: string;
}

async function writeFile(
  input: WriteFileInput,
): Promise<ToolResult<WriteFileOutput>> {
  try {
    const { path: rawPath, content, encoding, backup, createDirs } = input;
    const filePath = expandPath(rawPath);

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
    await fs.writeFile(filePath, content, encoding as BufferEncoding);

    // Get size
    const stats = await fs.stat(filePath);

    return {
      success: true,
      data: {
        path: filePath,
        size: stats.size,
        backed_up,
        backup_path,
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
  recursive: z.boolean().describe("Whether to scan recursively"),
  pattern: z
    .string()
    .describe("Glob pattern to filter files (use empty string for no filter)"),
  maxDepth: z.number().describe("Max recursion depth"),
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
    "Read contents of a file. Supports UTF-8, base64, and binary encodings.",
  inputSchema: ReadFileSchema,
  execute: readFile,
});

export const writeFileTool = createTool({
  id: "write_file",
  description:
    "Write content to a file. Creates parent directories if needed. Creates backup if specified.",
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
