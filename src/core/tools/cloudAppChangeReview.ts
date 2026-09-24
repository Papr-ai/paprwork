/**
 * Agent tools — review contribute-back PR diffs (owner).
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  buildCloudAppChangeReview,
  readCloudAppChangeFileAtHead,
} from "../../gateway/services/cloudAppChangeGitHubReview.js";
import { requirePaprCloudLogin } from "../../gateway/utils/cloudPublishGate.js";
import {
  CLOUD_APP_PR_OWNER_WORKFLOW,
  CLOUD_APP_PR_TOOL_IDS,
} from "./cloudAppPrToolIds.js";

function toolError(error: unknown, startTime: number): never {
  throw new Error(
    JSON.stringify({
      success: false,
      error: (error as Error).message,
      duration: performance.now() - startTime,
      timestamp: new Date().toISOString(),
    }),
  );
}

const reviewChangeSchema = z.object({
  requestId: z
    .string()
    .uuid()
    .describe(`Incoming PR request id from ${CLOUD_APP_PR_TOOL_IDS.list}`),
  maxFiles: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max file entries in diff (default 40)"),
});

const readChangeFileSchema = z.object({
  requestId: z.string().uuid(),
  relativePath: z
    .string()
    .min(1)
    .describe(
      "Path in the upstream per-app writer repo at the proposal HEAD (e.g. index.html, dist/app.js)",
    ),
  maxChars: z.number().int().min(500).max(100_000).optional(),
});

const ownerPrNotLocalDev =
  "OWNER ONLY — incoming contributor GitHub PR, not local app development. Do not use inspect_cloud_repo (default branch only) or edit_file on $PAPR_HOME/apps/ to review a proposal.";

export const getCloudAppPrReviewTool = createTool({
  id: CLOUD_APP_PR_TOOL_IDS.review,
  description: `Fetch the GitHub pull request diff for an incoming contribute-back PR (OWNER ONLY).

${ownerPrNotLocalDev}

Uses Papr's short-lived per-app GitHub read token — same credential family as inspect_cloud_repo, but reads the PR/contrib ref. Returns unified patches plus metadata (title, branch, headSha, stagedPaths).

Workflow: ${CLOUD_APP_PR_OWNER_WORKFLOW.steps.join(" → ")}`,
  inputSchema: reviewChangeSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof reviewChangeSchema> }).context ?? input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();
      const data = await buildCloudAppChangeReview({
        requestId: args.requestId,
        maxFiles: args.maxFiles,
      });
      return {
        success: true,
        data,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

export const readCloudAppPrFileTool = createTool({
  id: CLOUD_APP_PR_TOOL_IDS.readFile,
  description: `Read one file from an incoming contribute-back PR at its proposal HEAD ref (OWNER ONLY). Use after ${CLOUD_APP_PR_TOOL_IDS.review} when you need full file content beyond the patch. ${ownerPrNotLocalDev}`,
  inputSchema: readChangeFileSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof readChangeFileSchema> }).context ?? input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();
      const data = await readCloudAppChangeFileAtHead({
        requestId: args.requestId,
        relativePath: args.relativePath,
        maxChars: args.maxChars,
      });
      return {
        success: true,
        data,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

export const cloudAppPrReviewTools = [
  getCloudAppPrReviewTool,
  readCloudAppPrFileTool,
];

/** @deprecated use getCloudAppPrReviewTool */
export const getCloudAppChangeReviewTool = getCloudAppPrReviewTool;
/** @deprecated use readCloudAppPrFileTool */
export const readCloudAppChangeFileTool = readCloudAppPrFileTool;
/** @deprecated use cloudAppPrReviewTools */
export const cloudAppChangeReviewTools = cloudAppPrReviewTools;
