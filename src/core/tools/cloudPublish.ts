/**
 * Agent tools for cloud mini-app publish and sharing settings.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { CodeAccess } from "../utils/shareAudienceModel.js";
import {
  shouldListInCommunity,
  sharingToAudienceModel,
} from "../utils/shareAudienceModel.js";
import { getCloudAppPublishService } from "../../gateway/services/CloudAppPublishService.js";
import { getAppPublishPrefs } from "../../gateway/services/cloudPublishPrefs.js";
import {
  resolveSharingSettings,
  sharingSettingsRequireShareToken,
  sharingSettingsSummary,
  type CloudExternalLink,
  type CloudLoginAccess,
} from "../../gateway/services/cloudSharingSettings.js";
import {
  checkCloudPublishAvailable,
  requireCloudPublishAvailable,
  requirePaprCloudLogin,
  throwCloudPublishUnavailable,
} from "../../gateway/utils/cloudPublishGate.js";
import { formatShareLink } from "../utils/cloudShareLink.js";

const loginAccessSchema = z.enum(["private", "team", "public", "none"]);
const externalLinkSchema = z.enum(["off", "read", "read_write"]);
const codeAccessSchema = z.enum(["off", "install"]);

const getCloudAppPublishSchema = z.object({
  appId: z.string().uuid().describe("Mini-app ID"),
});

const publishCloudAppSchema = z.object({
  appId: z.string().uuid().describe("Mini-app ID to publish or update"),
  loginAccess: loginAccessSchema
    .optional()
    .describe(
      "Who can access via Papr login: private (owner), team, public, or none (invite link only)",
    ),
  externalLink: externalLinkSchema
    .optional()
    .describe(
      "External invite link: off, read (read-only secret URL), or read_write",
    ),
  codeAccess: codeAccessSchema
    .optional()
    .describe(
      "off = live app only. install = Edit the code — others can fork/install from Community (use with loginAccess=public for Community catalog).",
    ),
  unpublish: z
    .boolean()
    .optional()
    .describe("If true, removes the app from apps.papr.ai"),
});

function formatPublishResult(
  appId: string,
  config: Awaited<
    ReturnType<ReturnType<typeof getCloudAppPublishService>["getPublishConfig"]>
  >,
  sharing: ReturnType<typeof resolveSharingSettings>,
  codeAccess: CodeAccess,
): Record<string, unknown> {
  const externalEnabled = sharingSettingsRequireShareToken(sharing);
  const shareLink =
    formatShareLink(
      config.shareUrl,
      config.shareToken ?? null,
      config.accessMode,
      externalEnabled,
    ) ?? config.shareUrl;
  const externalLinkUrl =
    externalEnabled && shareLink?.includes("?t=") ? shareLink : null;
  const loginUrl =
    sharing.loginAccess === "none"
      ? null
      : externalLinkUrl
        ? config.shareUrl
        : shareLink ?? config.shareUrl;
  const audienceModel = sharingToAudienceModel(
    sharing.loginAccess,
    sharing.externalLink,
    codeAccess,
  );
  const inCommunity = shouldListInCommunity(
    audienceModel.audience,
    config.enabled,
  );

  return {
    appId,
    enabled: config.enabled,
    slug: config.slug,
    accessMode: config.accessMode,
    loginAccess: sharing.loginAccess,
    externalLink: sharing.externalLink,
    codeAccess,
    sharingSummary: sharingSettingsSummary(sharing),
    listedInCommunity: inCommunity,
    shareUrl: config.shareUrl,
    loginUrl,
    externalLinkUrl,
    publishedAt: config.publishedAt,
    tip: inCommunity && codeAccess === "install"
      ? "Listed in Community Apps — others can fork/install source while code stays on papr-work."
      : externalEnabled && !externalLinkUrl
        ? "External link enabled but no share token yet — republish or check memory server logs."
        : loginUrl
          ? "Team/private users open loginUrl. External users need externalLinkUrl with ?t= token."
          : "Only externalLinkUrl grants access.",
  };
}

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

export const getCloudAppPublishTool = createTool({
  id: "get_cloud_app_publish",
  description: `Get cloud publish status for a mini-app (apps.papr.ai).

Returns live status, slug, loginAccess, externalLink, codeAccess (off | install), Community listing, and URLs.

**Prefer this over export_app_bundle** when Cloud Sync + Papr login are enabled.
If Cloud Sync is off, the tool returns an error — use export_app_bundle instead (recommend enabling Cloud first).`,
  inputSchema: getCloudAppPublishSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof getCloudAppPublishSchema> }).context ??
      input;
    const startTime = performance.now();
    try {
      const gate = await checkCloudPublishAvailable();
      if (!gate.available) {
        throwCloudPublishUnavailable(gate);
      }

      const publishService = getCloudAppPublishService();
      const config = await publishService.getPublishConfig(args.appId);
      const prefs = getAppPublishPrefs(args.appId);
      const sharing = resolveSharingSettings({
        loginAccess: config.loginAccess,
        externalLink: config.externalLink,
        accessMode: config.accessMode,
      });
      const codeAccess: CodeAccess = prefs.codeAccess ?? "off";
      return {
        success: true,
        data: formatPublishResult(args.appId, config, sharing, codeAccess),
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

export const publishCloudAppTool = createTool({
  id: "publish_cloud_app",
  description: `Publish or update cloud sharing for a mini-app on apps.papr.ai.

**Preferred path for sharing** (when Cloud Sync + Papr login are on):
- **Community + fork/install:** loginAccess=public, codeAccess=install
- **Live web only:** loginAccess=public (or team/link), codeAccess=off
- **Private cloud:** loginAccess=private, externalLink=off

Three axes:
1. loginAccess — private | team | public | none
2. externalLink — off | read | read_write
3. codeAccess — off (view/use live app) | install (Edit the code — Community fork + install_cloud_app)

Set unpublish=true to remove from cloud entirely.

If Cloud Sync is disabled, returns an error with fallbackTool=export_app_bundle — recommend enabling Cloud, then retry.`,
  inputSchema: publishCloudAppSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof publishCloudAppSchema> }).context ??
      input;
    const startTime = performance.now();
    try {
      const publishService = getCloudAppPublishService();

      if (args.unpublish) {
        await requirePaprCloudLogin();
        await publishService.unpublishApp(args.appId);
        return {
          success: true,
          data: {
            appId: args.appId,
            enabled: false,
            message: "App unpublished from cloud",
          },
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      await requireCloudPublishAvailable();

      const sharing = resolveSharingSettings({
        loginAccess: args.loginAccess as CloudLoginAccess | undefined,
        externalLink: args.externalLink as CloudExternalLink | undefined,
      });
      const codeAccess: CodeAccess = args.codeAccess ?? "off";

      const config = await publishService.publishApp(args.appId, {
        loginAccess: sharing.loginAccess,
        externalLink: sharing.externalLink,
        codeAccess,
      });

      return {
        success: true,
        data: formatPublishResult(args.appId, config, sharing, codeAccess),
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

export const cloudPublishTools = [getCloudAppPublishTool, publishCloudAppTool];
