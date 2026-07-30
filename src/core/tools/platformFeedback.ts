/**
 * Platform feedback tool — submit bug reports and feature requests to GitHub.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolResult } from "../types/index.js";

const createPlatformIssueSchema = z.object({
  type: z
    .enum(["bug", "feature"])
    .describe("bug = something broken; feature = enhancement request"),
  title: z
    .string()
    .min(5)
    .max(200)
    .describe("Clear issue title, e.g. 'Bug: Chat input loses focus after job completes'"),
  body: z
    .string()
    .min(20)
    .describe(
      "Detailed description: for bugs include expected vs actual behavior and repro steps; " +
        "for features include problem, proposed solution, and why it matters",
    ),
  contactEmail: z
    .string()
    .email()
    .optional()
    .describe("Optional email if the user wants follow-up (ask first — never invent)"),
  userConfirmed: z
    .boolean()
    .describe(
      "true only after showing the user a draft title/body and they explicitly approve submission",
    ),
});

type CreatePlatformIssueArgs = z.infer<typeof createPlatformIssueSchema>;

export const createPlatformIssueTool = createTool({
  id: "create_platform_issue",
  description:
    "Submit a bug report or feature request to the Papr Work GitHub repository (Papr-ai/paprwork). " +
    "Requires Papr login (Settings → AI Models) — submission goes through the memory server; no GitHub account needed. " +
    "Use when helping users report platform issues through Settings → About → Report Issue / Feature Request. " +
    "Gather details, draft title and body, show the user for approval, then call with userConfirmed: true. " +
    "Never submit without explicit user confirmation.",
  inputSchema: createPlatformIssueSchema,
  execute: async (inputData): Promise<ToolResult> => {
    const args =
      (inputData as { context?: CreatePlatformIssueArgs }).context ?? inputData;
    const startTime = performance.now();

    if (!args.userConfirmed) {
      return {
        success: false,
        error:
          "User must confirm the issue draft before submission. Show title and body, ask for approval, then retry with userConfirmed: true.",
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const {
        canSubmitPlatformIssue,
        submitPlatformIssue,
      } = await import("../../gateway/services/PlatformFeedbackService.js");

      if (!(await canSubmitPlatformIssue())) {
        return {
          success: false,
          error:
            "Cannot submit automatically — user is not logged into Papr. " +
            "Ask them to sign in via Settings → AI Models → Login with Papr, then retry. " +
            "Or provide the draft for manual paste at https://github.com/Papr-ai/paprwork/issues " +
            "(repo may restrict public issue creation).",
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      const result = await submitPlatformIssue({
        type: args.type,
        title: args.title,
        body: args.body,
        contactEmail: args.contactEmail,
      });

      return {
        success: true,
        data: {
          issueNumber: result.issueNumber,
          issueUrl: result.issueUrl,
          title: result.title,
          via: result.via,
          message: `Issue #${result.issueNumber} created: ${result.issueUrl}`,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown platform feedback error";
      return {
        success: false,
        error: message,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  },
});

export const platformFeedbackTools = [createPlatformIssueTool];
