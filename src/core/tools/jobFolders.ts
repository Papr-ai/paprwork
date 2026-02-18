import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { JobGraph } from "../../gateway/services/JobsService.js";

const listJobFoldersSchema = z.object({});

const setJobFolderSchema = z.object({
  jobId: z.string().min(1).describe("ID of the job to assign"),
  folder: z
    .string()
    .optional()
    .describe(
      "Folder label (e.g. 'ingestion', 'reporting'). Omit or pass undefined to clear the folder assignment.",
    ),
});

const getJobGraphSchema = z.object({
  appId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Filter the graph to jobs linked to this app ID. Omit to get the full graph.",
    ),
});

type SetJobFolderArgs = z.infer<typeof setJobFolderSchema>;
type GetJobGraphArgs = z.infer<typeof getJobGraphSchema>;

export const listJobFoldersTool = createTool({
  id: "list_job_folders",
  description:
    "List all distinct folder names currently assigned to jobs. Call this before creating or assigning folders to understand existing groupings and avoid duplicates.",
  inputSchema: listJobFoldersSchema,
  execute: async () => {
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const folders = await jobsService.listJobFolders();
    return {
      success: true,
      data: {
        folders,
        count: folders.length,
        tip: "Use set_job_folder to assign a job to one of these folders, or use a new name to create a new folder.",
      },
    };
  },
});

export const setJobFolderTool = createTool({
  id: "set_job_folder",
  description: `Assign a job to a folder group for organisation. Folders are free-form string labels — they don't need to be created first, just assign the same name to related jobs.

Good folder names represent pipeline stages or functional groups:
- "ingestion" — jobs that fetch or receive raw data
- "processing" — transformation, enrichment, aggregation
- "reporting" — build reports, PDFs, dashboards
- "notifications" — send emails, Slack messages, webhooks

Avoid naming folders after apps (apps can link to jobs from multiple folders). Omit folder to clear the assignment.`,
  inputSchema: setJobFolderSchema,
  execute: async (input) => {
    const args = (input as { context?: SetJobFolderArgs }).context ?? input;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();
    const job = await jobsService.updateJob(args.jobId, { folder: args.folder });
    return {
      success: true,
      data: { jobId: job.id, name: job.name, folder: job.folder ?? null },
    };
  },
});

export const getJobGraphTool = createTool({
  id: "get_job_graph",
  description: `Get the full job dependency graph including folder groupings, app linkages, and dependency edges.

**Always call this before creating new jobs** for an existing pipeline to understand what already exists and how jobs relate to each other.

Returns:
- folders: which jobs belong to each folder
- appLinks: which apps are linked to which jobs (via data-sources)
- edges: dependency edges (job A must complete before job B)

Optionally filter to a specific app to see only its relevant jobs.`,
  inputSchema: getJobGraphSchema,
  execute: async (input) => {
    const args = (input as { context?: GetJobGraphArgs }).context ?? input;
    const { getJobsService } = await import("../../gateway/services/JobsService.js");
    const jobsService = getJobsService();
    await jobsService.initialize();

    const graph = await jobsService.getJobGraph();

    if (!graph) {
      return {
        success: true,
        data: { graph: null, message: "No jobs exist yet." },
      };
    }

    if (args.appId) {
      const appJobIds = new Set(graph.appLinks[args.appId]?.jobIds ?? []);
      const filteredFolders: Record<string, string[]> = {};
      for (const [folder, jobIds] of Object.entries(graph.folders)) {
        const visible = jobIds.filter((id) => appJobIds.has(id));
        if (visible.length > 0) filteredFolders[folder] = visible;
      }
      const filteredEdges = graph.edges.filter(
        (e) => appJobIds.has(e.from) && appJobIds.has(e.to),
      );
      const filteredGraph: JobGraph = {
        ...graph,
        folders: filteredFolders,
        edges: filteredEdges,
        appLinks: graph.appLinks[args.appId]
          ? { [args.appId]: graph.appLinks[args.appId] }
          : {},
      };
      return {
        success: true,
        data: { graph: filteredGraph, filteredByApp: args.appId },
      };
    }

    return { success: true, data: { graph } };
  },
});

export const jobFolderTools = [listJobFoldersTool, setJobFolderTool, getJobGraphTool];
