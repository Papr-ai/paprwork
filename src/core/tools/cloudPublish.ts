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
import {
  getCloudAppPublishService,
  type CloudAppPublishService,
} from "../../gateway/services/CloudAppPublishService.js";
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
  requireSignIn: z
    .boolean()
    .optional()
    .describe(
      "Public Community or link sharing: when true, visitors must sign in with Papr before using the live app.",
    ),
  perUserIsolation: z
    .boolean()
    .optional()
    .describe(
      "When true, linked registry databases use per-user Turso isolation (separate DB per signed-in user).",
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
  prefs?: {
    requireSignIn?: boolean;
    perUserIsolation?: boolean;
  },
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
    {
      requireSignIn: prefs?.requireSignIn,
      perUserIsolation: prefs?.perUserIsolation,
    },
  );
  const inCommunity = shouldListInCommunity(
    audienceModel.audience,
    config.enabled,
  );
  const signInRequired =
    sharing.loginAccess === "team" ||
    sharing.loginAccess === "private" ||
    prefs?.requireSignIn === true ||
    (sharing.loginAccess === "public" && sharing.externalLink !== "off");

  return {
    appId,
    enabled: config.enabled,
    slug: config.slug,
    accessMode: config.accessMode,
    loginAccess: sharing.loginAccess,
    externalLink: sharing.externalLink,
    codeAccess,
    requireSignIn: prefs?.requireSignIn ?? false,
    perUserIsolation: prefs?.perUserIsolation ?? false,
    signInRequired,
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

Returns live status, slug, loginAccess, externalLink, codeAccess (off | install), requireSignIn, perUserIsolation, Community listing, and URLs.

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
        data: formatPublishResult(args.appId, config, sharing, codeAccess, {
          requireSignIn: prefs.requireSignIn,
          perUserIsolation: prefs.perUserIsolation,
        }),
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

Three axes (memory server ACL):
1. loginAccess — private | team | public | none  → maps to visibility on memory server
2. externalLink — off | read | read_write
3. codeAccess — off (view/use live app) | install (Community fork + install_cloud_app)

**Share sheet / multi-user options:**
4. requireSignIn — Community (loginAccess=public, externalLink=off): force Papr sign-in while staying listed
5. perUserIsolation — paprwork-local: per-user Turso DBs (also via create_database({ isolation: "per-user" }))

**Examples:**
- Community, anonymous funnel: loginAccess=public, requireSignIn=false, perUserIsolation=false
- Community, sign-in + private data: loginAccess=public, requireSignIn=true, perUserIsolation=true
- Workspace app: loginAccess=team, perUserIsolation=true
- Unlisted invite, no account: loginAccess=none, externalLink=read_write

**Publish access ≠ row isolation.** Use perUserIsolation or create_database({ isolation: "per-user" }) for separate Turso DBs per user. Use owner_session column for anonymous funnels.

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

      const publishOptions: Parameters<CloudAppPublishService["publishApp"]>[1] =
        {};
      if (args.loginAccess !== undefined) {
        publishOptions.loginAccess = args.loginAccess as CloudLoginAccess;
      }
      if (args.externalLink !== undefined) {
        publishOptions.externalLink = args.externalLink as CloudExternalLink;
      }
      if (args.codeAccess !== undefined) {
        publishOptions.codeAccess = args.codeAccess;
      }
      if (args.requireSignIn !== undefined) {
        publishOptions.requireSignIn = args.requireSignIn;
      }
      if (args.perUserIsolation !== undefined) {
        publishOptions.perUserIsolation = args.perUserIsolation;
      }

      const config = await publishService.publishOrUpdateSharing(
        args.appId,
        publishOptions,
      );

      const prefs = getAppPublishPrefs(args.appId);
      const sharing = resolveSharingSettings({
        loginAccess: config.loginAccess,
        externalLink: config.externalLink,
        accessMode: config.accessMode,
      });
      const codeAccess: CodeAccess = prefs.codeAccess ?? args.codeAccess ?? "off";
      return {
        success: true,
        data: formatPublishResult(args.appId, config, sharing, codeAccess, {
          requireSignIn: prefs.requireSignIn,
          perUserIsolation: prefs.perUserIsolation,
        }),
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

export const cloudPublishTools = [getCloudAppPublishTool, publishCloudAppTool];
