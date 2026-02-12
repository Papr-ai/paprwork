/**
 * Tool Registry - Exports all available tools
 *
 * This is the central registry for all tools available to agents.
 * Add new tools here as they're implemented.
 */

import { bashTool } from "./bash.js";
import {
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  searchFilesTool,
  filesystemTools,
} from "./filesystem.js";

/**
 * All available tools
 */
export const allTools = [bashTool, ...filesystemTools];

/**
 * Tool categories for organization
 */
export const toolsByCategory = {
  system: [bashTool],
  filesystem: filesystemTools,
  // Future categories:
  // browser: [],
  // papr: [],
  // documents: [],
  // calendar: [],
} as const;

/**
 * Get tool by ID
 */
export function getToolById(
  id: string,
):
  | typeof bashTool
  | typeof readFileTool
  | typeof writeFileTool
  | typeof listDirectoryTool
  | typeof searchFilesTool
  | undefined {
  return allTools.find((tool) => tool.id === id);
}

/**
 * Get tools by category
 */
export function getToolsByCategory(category: keyof typeof toolsByCategory) {
  return toolsByCategory[category];
}

/**
 * Get all tool IDs
 */
export function getAllToolIds(): string[] {
  return allTools.map((tool) => tool.id);
}

// Re-export individual tools
export { bashTool } from "./bash.js";
export {
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  searchFilesTool,
  filesystemTools,
} from "./filesystem.js";

// Export security utilities
export {
  sanitizeError,
  sanitizeToolOutput,
  truncateResult,
  substituteCustomKeys,
  getApiKeysForSanitization,
  MAX_TOOL_RESULT_LENGTH,
} from "./security.js";

// Export types
export type { BashInput, BashOutput } from "./bash.js";

export type {
  ReadFileInput,
  ReadFileOutput,
  WriteFileInput,
  WriteFileOutput,
  ListDirectoryInput,
  ListDirectoryOutput,
  SearchFilesInput,
  SearchFilesOutput,
  FileInfo,
  SearchMatch,
} from "./filesystem.js";
