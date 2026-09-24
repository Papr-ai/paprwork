/**
 * Agent tools — install cloud apps + contribute-back change requests.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  ensureActiveWorkspaceEnvSynced,
  readActiveWorkspacePointer,
} from "../utils/paprWorkspace.js";
import { getCloudAppContributeService } from "../../gateway/services/CloudAppContributeService.js";
import {
  agentBrowseScopeToCatalogScope,
  buildAgentCommunityAppListings,
  type AgentCommunityBrowseScope,
} from "../../gateway/services/communityCatalogAgentBrowse.js";
import { getCommunityCatalogService } from "../../gateway/services/CommunityCatalogService.js";
import {
  CloudCatalogInstallChoiceRequiredError,
  runCloudCatalogInstall,
} from "../../gateway/services/runCloudCatalogInstall.js";
import { cloudApiFetch } from "../../gateway/utils/cloudApiClient.js";
import {
  requirePaprCloudLogin,
} from "../../gateway/utils/cloudPublishGate.js";
import {
  CLOUD_APP_PR_DEFERRED_FIND_QUERY,
  CLOUD_APP_PR_OWNER_WORKFLOW,
  CLOUD_APP_PR_TOOL_IDS,
} from "./cloudAppPrToolIds.js";
import { cloudAppPrReviewTools } from "./cloudAppChangeReview.js";
import { getCloudAppChangeRequestService } from "../../gateway/services/CloudAppChangeRequestService.js";
import type { IncomingChangeRequestStatus } from "../../gateway/services/CloudAppChangeRequestService.js";

const installCloudAppSchema = z.object({
  namespaceId: z.string().min(1).describe("Source app namespace ID"),
  slug: z.string().min(2).describe("Published slug on apps.papr.ai"),
  mode: z
    .enum(["fork", "track"])
    .optional()
    .describe(
      'fork = independent copy. track = shared team database (team-shared apps only). Omit on team-shared apps to get the same fork vs collaborate choice as the UI modal.',
    ),
  catalogScope: z
    .enum(["community", "team", "global", "namespace"])
    .optional()
    .describe(
      "Where the app was listed: community/global or team/namespace. Pass the same scope used in list_community_apps.",
    ),
  visibility: z
    .string()
    .optional()
    .describe(
      "From list_community_apps result (e.g. team, public_read). Required for correct fork vs collaborate rules.",
    ),
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

const listPrsSchema = z.object({
  appId: z
    .string()
    .uuid()
    .optional()
    .describe("Filter to PRs for this owner upstream app id"),
  status: z.enum(["preparing", "pending", "approved", "rejected"]).optional(),
});

const checkContributionsSchema = z.object({
  appId: z
    .string()
    .uuid()
    .describe("Owner upstream app id to check for incoming contributor PRs"),
});

const resolveChangeSchema = z.object({
  requestId: z.string().uuid(),
  action: z.enum(["approve", "reject"]),
});

const listCommunityAppsSchema = z.object({
  scope: z
    .enum(["community", "team"])
    .optional()
    .describe(
      "community = global Community Apps tab (default). team = workspace Team Apps tab.",
    ),
  query: z
    .string()
    .optional()
    .describe("Optional filter on name, description, author, or tags"),
  namespaceId: z
    .string()
    .optional()
    .describe(
      "Workspace namespace for team scope — defaults to the active Papr workspace",
    ),
});

export const listCommunityAppsTool = createTool({
  id: "list_community_apps",
  description: `List forkable/customizable Papr Cloud apps — the same catalog as the Community Apps and Team Apps tabs.

Requires Papr login. Returns only apps with codeAccess=install (Customize / fork via install_cloud_app).

Do NOT discover apps via paprwork-community-apps/registry.json, list_app_bundles, curl to apps.papr.ai, or /api/cloud/catalog — those are wrong or deprecated.`,
  inputSchema: listCommunityAppsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof listCommunityAppsSchema> }).context ??
      input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();

      const browseScope: AgentCommunityBrowseScope = args.scope ?? "community";
      const catalogScope = agentBrowseScopeToCatalogScope(browseScope);

      let namespaceId = args.namespaceId?.trim();
      if (catalogScope === "namespace") {
        ensureActiveWorkspaceEnvSynced();
        namespaceId =
          namespaceId ??
          process.env.PAPR_NAMESPACE_ID?.trim() ??
          readActiveWorkspacePointer()?.namespaceId?.trim();
        if (!namespaceId) {
          throw new Error(
            "Team Apps catalog requires an active Papr workspace. Sign in and select a workspace in Settings → Papr Account, or pass namespaceId.",
          );
        }
      }

      const catalog = await getCommunityCatalogService().fetchScopedCatalog({
        scope: catalogScope,
        namespaceId,
      });

      const apps = buildAgentCommunityAppListings(
        catalog.entries,
        catalogScope,
        args.query,
      );

      return {
        success: true,
        data: {
          scope: browseScope,
          namespaceId: catalog.namespaceId ?? namespaceId ?? null,
          total: apps.length,
          apps,
          fromCache: catalog.fromCache === true,
          tip:
            apps.length === 0
              ? browseScope === "team"
                ? "No forkable team apps yet. Teammates must publish with codeAccess=install (Edit the code)."
                : "No forkable community apps match. Publishers must enable Edit the code on their share settings."
              : "Pick an app and run install_cloud_app with namespaceId, slug, catalogScope, and visibility. Team-shared apps need fork vs collaborate — ask the user first or omit mode to get the same options as the UI.",
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

export const installCloudAppTool = createTool({
  id: "install_cloud_app",
  description: `Install a Papr Cloud mini-app source into the user's Paprwork workspace.

Uses the same install pipeline as the Community / Team Apps UI (POST /api/cloud/install).

Requires Papr login. Publisher must enable **Edit the code** (codeAccess=install).

For team-shared apps, ask the user fork vs collaborate before calling — or omit mode to receive the same options as the UI modal.`,
  inputSchema: installCloudAppSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof installCloudAppSchema> }).context ??
      input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();
      const result = await runCloudCatalogInstall({
        namespaceId: args.namespaceId,
        slug: args.slug,
        mode: args.mode,
        shareToken: args.shareToken,
        catalogScope: args.catalogScope,
        visibility: args.visibility,
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
      if (error instanceof CloudCatalogInstallChoiceRequiredError) {
        throw new Error(
          JSON.stringify({
            success: false,
            error: error.message,
            code: error.code,
            catalogScope: error.catalogScope,
            namespaceId: error.namespaceId,
            slug: error.slug,
            visibility: error.visibility,
            options: error.options,
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          }),
        );
      }
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

export const submitCloudAppPrTool = createTool({
  id: CLOUD_APP_PR_TOOL_IDS.submit,
  description: `Open a contribute-back GitHub PR to the upstream app owner (CONTRIBUTOR ONLY — local fork via install_cloud_app).

Not for editing the owner's app directly. Pushes your fork's app source, linked Jobs, and migration SQL to the owner's papr-work repo. Returns prUrl, branch, and headSha.`,
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

export const checkCloudAppContributionsTool = createTool({
  id: CLOUD_APP_PR_TOOL_IDS.check,
  description: `Check whether an app you own has incoming contributor PRs (OWNER ONLY). Lightweight first step before loading full PR review tools.

Returns pending/preparing counts and request summaries. If PRs exist, use ${CLOUD_APP_PR_TOOL_IDS.review} for diffs (not inspect_cloud_repo or local edit_file). If PR tools are deferred this turn, call find_tools({ query: "${CLOUD_APP_PR_DEFERRED_FIND_QUERY}" }) then run_deferred_tool.`,
  inputSchema: checkContributionsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof checkContributionsSchema> }).context ??
      input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();
      const service = getCloudAppChangeRequestService();
      const forApp = await service.listIncoming({ appId: args.appId });
      const pending = forApp.filter(
        (r) => r.status === "pending" || r.status === "preparing",
      );
      return {
        success: true,
        data: {
          appId: args.appId,
          totalMatchingApp: forApp.length,
          pendingCount: pending.length,
          requests: pending.map((r) => ({
            requestId: r.id,
            status: r.status,
            title: r.title,
            sourceSlug: r.sourceSlug,
            createdAt: r.createdAt,
          })),
          workflow: CLOUD_APP_PR_OWNER_WORKFLOW,
          deferredDiscoveryQuery: CLOUD_APP_PR_DEFERRED_FIND_QUERY,
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

export const listCloudAppPrsTool = createTool({
  id: CLOUD_APP_PR_TOOL_IDS.list,
  description: `List incoming contribute-back GitHub PRs for apps you own (OWNER ONLY). Optional appId filter. For diffs use ${CLOUD_APP_PR_TOOL_IDS.review} — not inspect_cloud_repo (default branch) or local edit_file.`,
  inputSchema: listPrsSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof listPrsSchema> }).context ?? input;
    const startTime = performance.now();
    try {
      await requirePaprCloudLogin();
      const service = getCloudAppChangeRequestService();
      const requests = await service.listIncoming({
        appId: args.appId,
        status: args.status as IncomingChangeRequestStatus | undefined,
      });
      return {
        success: true,
        data: { requests },
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

export const resolveCloudAppPrTool = createTool({
  id: CLOUD_APP_PR_TOOL_IDS.resolve,
  description: `Approve or reject an incoming contribute-back GitHub PR (OWNER ONLY). Approve merges on GitHub then runs Get updates (pullAppFromCloud) for the source app — do not push local over the merge. Review first with ${CLOUD_APP_PR_TOOL_IDS.review}.`,
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
        const { readSourceAppIdFromApproveBody, followUpContributeApprove } =
          await import(
            "../../gateway/services/contributeApproveFollowUp.js"
          );
        const sourceAppId = readSourceAppIdFromApproveBody(data);
        const pull = await followUpContributeApprove(sourceAppId);
        return {
          success: true,
          data: { ...data, pull, sourceAppId },
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      if (args.action === "reject") {
        const {
          notifyCloudChangeRequestsStale,
          readSourceAppIdFromApproveBody,
        } = await import("../../gateway/services/contributeApproveFollowUp.js");
        notifyCloudChangeRequestsStale(readSourceAppIdFromApproveBody(data));
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
  listCommunityAppsTool,
  installCloudAppTool,
  checkCloudAppContributionsTool,
  submitCloudAppPrTool,
  listCloudAppPrsTool,
  resolveCloudAppPrTool,
  ...cloudAppPrReviewTools,
];

/** @deprecated use submitCloudAppPrTool */
export const submitCloudAppChangeTool = submitCloudAppPrTool;
/** @deprecated use listCloudAppPrsTool */
export const listCloudAppChangesTool = listCloudAppPrsTool;
/** @deprecated use resolveCloudAppPrTool */
export const resolveCloudAppChangeTool = resolveCloudAppPrTool;
