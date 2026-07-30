/**
 * Agent tools — install cloud apps + contribute-back change requests.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getCloudAppInstallService } from "../../gateway/services/CloudAppInstallService.js";
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
  status: z.enum(["pending", "approved", "rejected"]).optional(),
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
          tip: "Open the app tab to edit locally. Your API keys stay in your Settings — not the owner's.",
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
  description: `Submit a contribute-back change request to the owner of a cloud app you forked.

Owner receives the request and can approve or reject. On approve, fork files merge into your published app locally and cloud sync pushes to papr-work git.`,
  inputSchema: submitChangeSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof submitChangeSchema> }).context ??
      input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();
      const response = await cloudApiFetch("/v1/cloud/apps/changes", {
        method: "POST",
        body: args,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Change request failed (${response.status}): ${body.slice(0, 200)}`,
        );
      }
      const data = (await response.json()) as Record<string, unknown>;
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
  description: `List incoming contribute-back change requests for apps you own (cloud publish owner).`,
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
  description: `Approve or reject an incoming contribute-back change request (owner only).`,
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
