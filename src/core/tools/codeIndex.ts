import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPaprAppsRoot, getPaprJobsRoot } from "../utils/paprRoot.js";

const projectIdSchema = z.object({
  projectId: z
    .string()
    .min(1)
    .describe("Mini-app or job ID (folder under $PAPR_HOME/apps/ or $PAPR_HOME/Jobs/)"),
});

const fileSummarySchema = projectIdSchema.extend({
  filePath: z
    .string()
    .min(1)
    .describe("Absolute path or project-relative path (e.g. app.tsx, src/chart.ts)"),
});

async function resolveFileSummary(projectId: string, filePath: string) {
  const { getSharedCodeIndexTracker } = await import(
    "../../gateway/services/CodeIndexingService.js"
  );
  const tracker = getSharedCodeIndexTracker();

  let resolvedPath = filePath;
  if (!filePath.startsWith("/") && !filePath.includes("Papr/")) {
    const pathMod = await import("path");
    const fs = await import("fs");

    const appCandidate = pathMod.join(getPaprAppsRoot(), projectId, filePath);
    const jobCandidate = pathMod.join(getPaprJobsRoot(), projectId, filePath);

    if (fs.existsSync(appCandidate)) {
      resolvedPath = appCandidate;
    } else if (fs.existsSync(jobCandidate)) {
      resolvedPath = jobCandidate;
    }
  }

  return { tracker, resolvedPath };
}

export const getProjectCodeOverviewTool = createTool({
  id: "get_project_code_overview",
  description:
    "Fetch the cached project code overview (architecture summary synthesized from file summaries). " +
    "Use this FIRST before reading individual files — instant local lookup, not semantic search.",
  inputSchema: projectIdSchema,
  execute: async (input) => {
    const args = (input as { context?: z.infer<typeof projectIdSchema> }).context ?? input;
    const { getSharedCodeIndexTracker } = await import(
      "../../gateway/services/CodeIndexingService.js"
    );
    const tracker = getSharedCodeIndexTracker();
    const overview = tracker.getProjectOverview(args.projectId);

    if (!overview) {
      return {
        success: false,
        error:
          `No project overview cached for "${args.projectId}". ` +
          "Indexing may still be in progress — wait a few seconds after edits, or use search_agent_memory as fallback.",
      };
    }

    return {
      success: true,
      data: {
        projectId: overview.project_id,
        projectType: overview.project_type,
        fileCount: overview.file_count,
        updatedAt: overview.updated_at.toISOString(),
        overview: overview.overview_text,
      },
    };
  },
});

export const getFileCodeSummaryTool = createTool({
  id: "get_file_code_summary",
  description:
    "Fetch the cached summary for a single source file in a project. " +
    "Use before read_app_file when you only need orientation, not full source.",
  inputSchema: fileSummarySchema,
  execute: async (input) => {
    const args = (input as { context?: z.infer<typeof fileSummarySchema> }).context ?? input;
    const { tracker, resolvedPath } = await resolveFileSummary(args.projectId, args.filePath);
    const summary = tracker.getFileSummary(resolvedPath);

    if (!summary) {
      return {
        success: false,
        error:
          `No file summary cached for "${args.filePath}" in project "${args.projectId}". ` +
          "File may be new or indexing in progress.",
      };
    }

    return {
      success: true,
      data: {
        projectId: summary.project_id,
        filePath: summary.file_path,
        fileName: summary.file_name,
        language: summary.language,
        updatedAt: summary.updated_at.toISOString(),
        summary: summary.summary_text,
      },
    };
  },
});

export const listFileCodeSummariesTool = createTool({
  id: "list_file_code_summaries",
  description:
    "List all cached per-file code summaries for a project. " +
    "Use to see what files exist and what each does without reading source.",
  inputSchema: projectIdSchema,
  execute: async (input) => {
    const args = (input as { context?: z.infer<typeof projectIdSchema> }).context ?? input;
    const { getSharedCodeIndexTracker } = await import(
      "../../gateway/services/CodeIndexingService.js"
    );
    const tracker = getSharedCodeIndexTracker();
    const summaries = tracker.getFileSummariesForProject(args.projectId);

    if (summaries.length === 0) {
      return {
        success: false,
        error:
          `No file summaries cached for project "${args.projectId}". ` +
          "Indexing may still be in progress.",
      };
    }

    return {
      success: true,
      data: {
        projectId: args.projectId,
        count: summaries.length,
        files: summaries.map((entry) => ({
          filePath: entry.file_path,
          fileName: entry.file_name,
          language: entry.language,
          updatedAt: entry.updated_at.toISOString(),
          summary: entry.summary_text,
        })),
      },
    };
  },
});

export const codeIndexTools = [
  getProjectCodeOverviewTool,
  getFileCodeSummaryTool,
  listFileCodeSummariesTool,
];
