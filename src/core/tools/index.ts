/**
 * Tool Registry - Exports all available tools
 *
 * This is the central registry for all tools available to agents.
 * Add new tools here as they're implemented.
 */

import { bashTool } from "./bash.js";
import { filesystemTools } from "./filesystem.js";
import { browserTools } from "./browser.js";
import { documentTools } from "./documents.js";
import { paprMemoryTools } from "./paprMemory.js";
import { skillsTools } from "./skills.js";
import { appJobsTools } from "./appJobs.js";
import { jobFolderTools } from "./jobFolders.js";
import { webviewTools } from "./webview.js";
import { delegationTools } from "./delegation.js";
import { planningTools } from "./planning.js";
import { keyManagementTools } from "./keyManagement.js";

/**
 * All available tools
 */
export const allTools = [
  bashTool,
  ...filesystemTools,
  ...browserTools,
  ...documentTools,
  ...paprMemoryTools,
  ...skillsTools,
  ...appJobsTools,
  ...jobFolderTools,
  ...webviewTools,
  ...delegationTools,
  ...planningTools,
  ...keyManagementTools,
];

/**
 * Tool categories for organization
 */
export const toolsByCategory = {
  system: [bashTool],
  filesystem: filesystemTools,
  browser: browserTools,
  webview: webviewTools,
  papr: paprMemoryTools,
  documents: documentTools,
  skills: skillsTools,
  automation: appJobsTools,
  delegation: delegationTools,
  planning: planningTools,
  keyManagement: keyManagementTools,
} as const;

/**
 * Get tool by ID
 */
export function getToolById(id: string): (typeof allTools)[number] | undefined {
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
export { browserTools } from "./browser.js";
export { webviewTools } from "./webview.js";
export {
  delegationTools,
  listSubAgentsTool,
  createSubAgentTool,
  deleteSubAgentTool,
  delegateTaskTool,
  getDelegationRunTool,
  listDelegationRunsTool,
} from "./delegation.js";
export { documentTools } from "./documents.js";
export { paprMemoryTools } from "./paprMemory.js";
export { skillsTools } from "./skills.js";
export {
  appJobsTools,
  createAppTool,
  createJobTool,
  runJobTool,
  readJobLogsTool,
  listJobsTool,
  listJobFilesTool,
  readJobFileTool,
  editJobFileTool,
  updateJobTool,
  deleteJobTool,
  getJobHistoryTool,
  getJobStatsTool,
  linkAppDataSourceTool,
  readAppDataSourcesTool,
  readAppFileTool,
  editAppFileTool,
  editAppFileLinesTool,
  listAppFilesTool,
  listAppsTool,
  exportAppBundleTool,
  importAppBundleTool,
  listAppBundlesTool,
  getAppBundleInfoTool,
} from "./appJobs.js";

export {
  jobFolderTools,
  listJobFoldersTool,
  setJobFolderTool,
  getJobGraphTool,
} from "./jobFolders.js";

export { planningTools, createPlanTool, updatePlanTool } from "./planning.js";

export {
  keyManagementTools,
  listKeysTool,
  getKeyTool,
  setKeyTool,
  deleteKeyTool,
  requestKeyTool,
} from "./keyManagement.js";

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
