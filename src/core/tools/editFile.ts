/**
 * Unified file edit tool — one entry point for mini-apps, jobs, and external repos.
 */

import path from "path";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { resolvePaprAgentPath } from "../utils/paprAgentPaths.js";
import { resolveEditFileTarget } from "../utils/resolveEditFileTarget.js";
import { runEditExternalFile } from "./fileEditExecutor.js";
import { runEditAppFile, runEditJobFile } from "./appJobs.js";

function expandPath(filePath: string): string {
  return resolvePaprAgentPath(filePath);
}

const EditFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "File path to edit (absolute, or ~/…). Mini-apps under $PAPR_HOME/apps/ auto-run esbuild + validation; jobs under $PAPR_HOME/Jobs/ get version snapshots.",
    ),
  oldString: z
    .string()
    .min(1)
    .describe(
      "Exact string to find and replace. Must match character-for-character including whitespace.",
    ),
  newString: z
    .string()
    .describe(
      "Replacement string. Use empty string to delete the matched section.",
    ),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Which match to replace when oldString appears multiple times (1-indexed). " +
        "Required when oldString is ambiguous.",
    ),
});

export type EditFileInput = z.infer<typeof EditFileSchema>;

export const editFileTool = createTool({
  id: "edit_file",
  description:
    "Edit any file by replacing an exact string with a new string. " +
    "Use for quick patches in mini-apps, jobs, GitHub repos, or any path on disk. " +
    "Always read_file (or read_app_file) first to get exact current content. " +
    "Paths under $PAPR_HOME/apps/ automatically run esbuild + validate_app after the edit. " +
    "Paths under $PAPR_HOME/Jobs/ save a version snapshot before editing. " +
    "External repo paths are auto-staged in git when applicable. " +
    "For multi-line HTML/JS/CSS blocks in mini-apps, prefer edit_app_file_lines (line ranges). " +
    "If oldString appears more than once, pass occurrence or add more surrounding context.",
  inputSchema: EditFileSchema,
  execute: async (input) => {
    const args = (input as { context?: EditFileInput }).context ?? input;
    const resolvedPath = path.resolve(expandPath(args.path));
    const target = resolveEditFileTarget(resolvedPath);

    if (target.kind === "blocked") {
      throw new Error(target.reason);
    }

    if (target.kind === "mini_app") {
      return runEditAppFile({
        appId: target.appId,
        filename: target.filename,
        oldString: args.oldString,
        newString: args.newString,
        occurrence: args.occurrence,
      });
    }

    if (target.kind === "job") {
      return runEditJobFile({
        jobId: target.jobId,
        filename: target.filename,
        oldString: args.oldString,
        newString: args.newString,
        occurrence: args.occurrence,
      });
    }

    return runEditExternalFile({
      path: target.resolvedPath,
      oldString: args.oldString,
      newString: args.newString,
      occurrence: args.occurrence,
    });
  },
});
