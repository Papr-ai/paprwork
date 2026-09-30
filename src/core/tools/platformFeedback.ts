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
      "Public markdown for GitHub — posted verbatim. No emails, names, paths, app/job names, chat content, " +
        "or secrets. Generic Papr Work repro steps and placeholders. contactEmail is separate (Mongo-only). " +
        "For bugs: expected vs actual behavior. For features: product gap in generic terms.",
    ),
  contactEmail: z
    .string()
    .email()
    .optional()
    .describe(
      "Optional email for Papr team follow-up only — ask first, never invent. Do NOT repeat email in body.",
    ),
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
    "Submit a PUBLIC bug report or feature request to Papr-ai/paprwork on GitHub (title+body posted as-is). " +
    "Use for Papr Work platform issues: crashes, UI bugs, settings/sync/update problems, feature requests. " +
    "Also when user uses Settings → About → Report Issue / Feature Request. " +
    "Do NOT use for bugs in the user's mini-apps, jobs, or private projects. " +
    "Sanitize title and body for public GitHub. contactEmail is optional and Mongo-only (never in body). " +
    "Submitter identity attached via Papr login, not in GitHub. Requires Papr login. Show draft, get userConfirmed: true.",
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
          submissionId: result.submissionId,
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
