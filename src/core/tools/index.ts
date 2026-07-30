/**
 * Tool Registry - Exports all available tools
 *
 * This is the central registry for all tools available to agents.
 * Add new tools here as they're implemented.
 */

import { bashTool } from "./bash.js";
import { filesystemTools } from "./filesystem.js";
import { browserTools } from "./browser.js";
import { pageWaitTools } from "./pageWait.js";
import { documentTools } from "./documents.js";
import { paprMemoryTools } from "./paprMemory.js";
import { paprDocumentMemoryTools } from "./paprDocumentMemory.js";
import { skillsTools } from "./skills.js";
import { appJobsTools } from "./appJobs.js";
import { jobFolderTools } from "./jobFolders.js";
import { webviewTools } from "./webview.js";
import { delegationTools } from "./delegation.js";
import { planningTools } from "./planning.js";
import { recipeTools } from "./recipes.js";
import { keyManagementTools } from "./keyManagement.js";
import { chatHistoryTools } from "./chatHistory.js";
import { connectorsTools } from "./connectors.js";
import { codeIndexTools } from "./codeIndex.js";
import { cloudPublishTools } from "./cloudPublish.js";
import { cloudInstallTools } from "./cloudInstall.js";
import { appAgentChatTools } from "./appAgentChat.js";
import { editFileTool } from "./editFile.js";
import { editAppFileTool, editJobFileTool } from "./appJobs.js";
import {
  createDatabaseTool,
  attachDatabaseTool,
  deleteDatabaseTool,
} from "./databases.js";
import { wikiGraphTools } from "./wikiGraph.js";
import { paprWorkspaceTools } from "./paprWorkspace.js";
import { platformFeedbackTools } from "./platformFeedback.js";

export const databaseTools = [
  createDatabaseTool,
  attachDatabaseTool,
  deleteDatabaseTool,
];

/**
 * All available tools
 */
export const allTools = [
  bashTool,
  ...filesystemTools,
  editFileTool,
  ...browserTools,
  ...pageWaitTools,
  ...documentTools,
  ...paprMemoryTools,
  ...paprDocumentMemoryTools,
  ...paprWorkspaceTools,
  ...wikiGraphTools,
  ...skillsTools,
  ...appJobsTools,
  ...databaseTools,
  ...jobFolderTools,
  ...webviewTools,
  ...delegationTools,
  ...planningTools,
  ...keyManagementTools,
  ...recipeTools,
  ...chatHistoryTools,
  ...connectorsTools,
  ...codeIndexTools,
  ...cloudPublishTools,
  ...cloudInstallTools,
  ...appAgentChatTools,
  ...platformFeedbackTools,
];

/**
 * Legacy tool aliases — same backends as edit_file, old schemas (appId/filename).
 * Registered separately; hidden from main agent, available for saved sub-agent profiles.
 */
export const legacyToolAliases = [editAppFileTool, editJobFileTool];

/**
 * Tool categories for organization
 */
export const toolsByCategory = {
  system: [bashTool],
  filesystem: [...filesystemTools, editFileTool],
  browser: browserTools,
  webview: webviewTools,
  papr: [...paprMemoryTools, ...paprDocumentMemoryTools, ...paprWorkspaceTools, ...wikiGraphTools],
  documents: documentTools,
  skills: skillsTools,
  automation: [...appJobsTools, ...databaseTools, ...appAgentChatTools],
  delegation: delegationTools,
  planning: planningTools,
  keyManagement: keyManagementTools,
  recipes: recipeTools,
  chatHistory: chatHistoryTools,
  connectors: connectorsTools,
  codeIndex: codeIndexTools,
  cloudPublish: cloudPublishTools,
  cloudInstall: cloudInstallTools,
  platformFeedback: platformFeedbackTools,
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
export { editFileTool } from "./editFile.js";
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
export {
  paprWorkspaceTools,
  getPaprWorkspaceTool,
} from "./paprWorkspace.js";
export {
  addAgentMemoryTool,
  searchAgentMemoryTool,
  submitMemoryFeedbackTool,
  registerSchemaTool,
  updateSchemaTool,
  listSchemasTool,
  getSchemaTool,
  listSignalDomainsTool,
  introspectMemoryGraphTool,
  queryMemoryGraphTool,
  deleteMemoryTool,
  deleteSchemaTool,
  createEntitiesAndRelationshipsTool,
} from "./paprMemory.js";
export {
  paprDocumentMemoryTools,
  uploadDocumentToMemoryTool,
  getDocumentUploadStatusTool,
  parsePdfTool,
} from "./paprDocumentMemory.js";
export { skillsTools } from "./skills.js";
export {
  appJobsTools,
  createAppTool,
  deleteAppTool,
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
  readAppDataHealthTool,
  normalizeAppDatabasesTool,
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
  cloudInstallTools,
  installCloudAppTool,
  submitCloudAppChangeTool,
  listCloudAppChangesTool,
  resolveCloudAppChangeTool,
} from "./cloudInstall.js";

export { appAgentChatTools, enableAppAgentChatTool } from "./appAgentChat.js";

export {
  jobFolderTools,
  listJobFoldersTool,
  setJobFolderTool,
  getJobGraphTool,
} from "./jobFolders.js";

export { planningTools, createPlanTool, updatePlanTool, deletePlanTool } from "./planning.js";
export { writeRecipeTool, readRecipeTool, evaluateRunTool, listEvaluationsTool } from "./recipes.js";
export { chatHistoryTools, getFullToolResultTool } from "./chatHistory.js";
export { connectorsTools, provisionServiceTool } from "./connectors.js";
export {
  codeIndexTools,
  getProjectCodeOverviewTool,
  getFileCodeSummaryTool,
  listFileCodeSummariesTool,
} from "./codeIndex.js";

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
