import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  formatPaprPathForAgent,
  getPaprWorkspacePathsForAgent,
} from "../utils/paprAgentPaths.js";

const getPaprWorkspaceSchema = z.object({});

export const getPaprWorkspaceTool = createTool({
  id: "get_papr_workspace",
  description:
    "Return the active Papr org/namespace workspace paths (paprHome, appsRoot, jobsRoot, dataDir, organizationId, namespaceId). " +
    "Call this before constructing $PAPR_HOME paths — prefer app/job tools over raw paths.",
  inputSchema: getPaprWorkspaceSchema,
  execute: async () => {
    const startTime = performance.now();
    const paths = getPaprWorkspacePathsForAgent();

    return {
      success: true,
      data: {
        organizationId: paths.organizationId,
        namespaceId: paths.namespaceId,
        usesOrgNamespaceLayout: paths.usesOrgNamespaceLayout,
        paprHome: formatPaprPathForAgent(paths.paprHome),
        appsRoot: formatPaprPathForAgent(paths.appsRoot),
        jobsRoot: formatPaprPathForAgent(paths.jobsRoot),
        dataDir: formatPaprPathForAgent(paths.dataDir),
        workspaceDir: formatPaprPathForAgent(paths.workspaceDir),
        tip: paths.usesOrgNamespaceLayout
          ? "Org/namespace layout active — use read_app_file / edit_app_file / list_jobs (not legacy flat ~/Papr/apps at Papr base)."
          : "Legacy flat layout — still prefer app/job tools when available.",
      },
      duration: performance.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  },
});

export const paprWorkspaceTools = [getPaprWorkspaceTool];
