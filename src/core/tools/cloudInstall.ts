/**
 * Agent tools — install cloud apps + contribute-back change requests.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getCloudAppInstallService } from "../../gateway/services/CloudAppInstallService.js";
import { getCloudAppContributeService } from "../../gateway/services/CloudAppContributeService.js";
import { getCloudSyncService } from "../../gateway/services/CloudSyncService.js";
import { cloudApiFetch } from "../../gateway/utils/cloudApiClient.js";
import {
  requirePaprCloudLogin,
} from "../../gateway/utils/cloudPublishGate.js";

const installCloudAppSchema = z.object({
  namespaceId: z.string().min(1).describe("Source app namespace ID"),
  slug: z.string().min(2).describe("Published slug on apps.papr.ai"),
  mode: z
    .enum(["fork", "track"])
    .optional()
    .describe("fork = independent copy (default). track = link to publisher; pull updates manually in Local preview"),
  shareToken: z
    .string()
    .optional()
    .describe("Share token if installing from a secret link"),
});

const submitChangeSchema = z.object({
  sourceNamespaceId: z.string().min(1),
  sourceSlug: z.string().min(2),
  installedAppId: z.string().uuid().describe("Your local fork app ID"),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
});

const listChangesSchema = z.object({
  status: z.enum(["preparing", "pending", "approved", "rejected"]).optional(),
});

const resolveChangeSchema = z.object({
  requestId: z.string().uuid(),
  action: z.enum(["approve", "reject"]),
});

export const installCloudAppTool = createTool({
  id: "install_cloud_app",
  description: `Install a Papr Cloud mini-app source into the user's Paprwork workspace.

Requires Papr login. Publisher must enable **Edit the code** (codeAccess=install) on their publish settings.

Creates a local copy with papr-cloud-lineage.json (fork or track mode). Use submit_cloud_app_change to propose updates back to the owner.`,
  inputSchema: installCloudAppSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof installCloudAppSchema> }).context ??
      input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();
      const result = await getCloudAppInstallService().installApp({
        namespaceId: args.namespaceId,
        slug: args.slug,
        mode: args.mode ?? "fork",
        shareToken: args.shareToken,
      });
      return {
        success: true,
        data: {
          appId: result.app.id,
          title: result.app.title,
          mode: result.mode,
          lineageId: result.lineageId,
          sourceAppId: result.sourceAppId,
          sourceSlug: result.sourceSlug,
          remappedFiles: result.remappedFiles,
          copiedJobIds: result.copiedJobIds,
          bootstrap: result.bootstrap,
          agentSetupMessage: result.agentSetupMessage,
          tip: result.agentSetupMessage
            ? "Database setup needs follow-up — use the agentSetupMessage in chat to finish migrations/Turso/seed job."
            : "Open the app tab to edit locally. Your API keys stay in your Settings — not the owner's.",
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: (error as Error).message,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

export const submitCloudAppChangeTool = createTool({
  id: "submit_cloud_app_change",
  description: `Propose contribute-back changes to the upstream app owner (CONTRIBUTOR ONLY — you must have a local fork installed via install_cloud_app).

Opens a pull request with your fork's app source, linked Jobs, and migration SQL on the owner's papr-work repo. Returns prUrl, branch, and headSha.`,
  inputSchema: submitChangeSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof submitChangeSchema> }).context ??
      input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();
      const data = await getCloudAppContributeService().propose({
        sourceNamespaceId: args.sourceNamespaceId,
        sourceSlug: args.sourceSlug,
        installedAppId: args.installedAppId,
        title: args.title,
        description: args.description,
      });
      return {
        success: true,
        data,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: (error as Error).message,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

export const listCloudAppChangesTool = createTool({
  id: "list_cloud_app_changes",
  description: `List incoming contribute-back pull requests for apps you own (OWNER ONLY — published upstream apps).`,
  inputSchema: listChangesSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof listChangesSchema> }).context ?? input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();
      const query = args.status ? `?status=${args.status}` : "";
      const response = await cloudApiFetch(
        `/v1/cloud/apps/changes/incoming${query}`,
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `List changes failed (${response.status}): ${body.slice(0, 200)}`,
        );
      }
      const data = (await response.json()) as { requests?: unknown[] };
      return {
        success: true,
        data: { requests: data.requests ?? [] },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: (error as Error).message,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

export const resolveCloudAppChangeTool = createTool({
  id: "resolve_cloud_app_change",
  description: `Approve or reject an incoming contribute-back PR (OWNER ONLY). Approve merges the GitHub PR and triggers a local sync pull. Use list_cloud_app_changes first to get requestId and prUrl.`,
  inputSchema: resolveChangeSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof resolveChangeSchema> }).context ??
      input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();
      const path =
        args.action === "approve"
          ? `/v1/cloud/apps/changes/${args.requestId}/approve`
          : `/v1/cloud/apps/changes/${args.requestId}/reject`;
      const response = await cloudApiFetch(path, { method: "POST" });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Resolve change failed (${response.status}): ${body.slice(0, 200)}`,
        );
      }
      const data = (await response.json()) as Record<string, unknown>;

      if (args.action === "approve") {
        const sync = getCloudSyncService();
        if (sync) {
          await sync.pullNow();
          void sync.pushNow();
        }
      }

      return {
        success: true,
        data,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        JSON.stringify({
          success: false,
          error: (error as Error).message,
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  },
});

export const cloudInstallTools = [
  installCloudAppTool,
  submitCloudAppChangeTool,
  listCloudAppChangesTool,
  resolveCloudAppChangeTool,
];
