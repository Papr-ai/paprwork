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
import { appendLineageToPublishData } from "../utils/cloudPublishLineageHints.js";
import { getCloudAppLineageService } from "../../gateway/services/CloudAppLineageService.js";
import {
  audiencesPatchFromSharing,
  audiencesAccessMode,
  describeAudiences,
  fetchAudiences,
  saveAudiences,
  type AudiencesAccess,
} from "../../gateway/services/cloudAppAudiences.js";
import { sharedCoverKind } from "../../gateway/services/appDemoVideos.js";

/** Who can open the app per the server (same source the Share sheet reads). Never throws. */
async function readAudiences(appId: string): Promise<AudiencesAccess | null> {
  return fetchAudiences(appId).catch(() => null);
}

/** Fold the live audiences into the tool result so agents see what the Share sheet shows. */
function withAudiences(data: Record<string, unknown>, a: AudiencesAccess | null): Record<string, unknown> {
  const view = describeAudiences(a);
  if (!view) return data;
  const linkOn = view.link !== "none";
  const shareUrl = typeof data.shareUrl === "string" ? data.shareUrl.split("?")[0] : null;
  const externalLinkUrl = linkOn && a?.shareToken && shareUrl ? `${shareUrl}?t=${a.shareToken}` : data.externalLinkUrl ?? null;
  // Legacy fields follow the audience roles (what the sheet shows), not the server's lagging visibility.
  const accessMode = a ? audiencesAccessMode(a) : undefined;
  return {
    ...data,
    ...(accessMode ? { accessMode } : {}),
    externalLink: !linkOn ? "off" : view.link === "viewer" ? "read" : "read_write",
    audiences: view,
    listedInCommunity: view.community !== "none",
    externalLinkUrl,
    signInRequired: view.community === "none" && !linkOn ? true : view.requireSignIn === true,
    sharingSummary: [
      view.workspace !== "none" && `Workspace: ${view.workspace}`,
      linkOn && `Anyone with the link: ${view.link}`,
      view.community !== "none" && `Community: ${view.community}`,
    ].filter(Boolean).join(" · ") || "Only you",
    tip: linkOn && !a?.shareToken
      ? "Link audience is on but the server returned no share token yet."
      : "Matches the Share sheet (People with access / Public access).",
  };
}

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

async function readLineageForPublishTool(appId: string) {
  return getCloudAppLineageService().readLineageForApp(appId);
}

function toolError(error: unknown, startTime: number): never {
  // Structured publish blockers (private tables) keep their detail so the
  // agent gets { code, tables[{ table, rule, sites[] }] } — not just text.
  const code = (error as { code?: string }).code;
  const detail = code === "private_table_violation" || code === "app_keys_undeclared"
    ? (error as { detail?: unknown }).detail
    : undefined;
  throw new Error(
    JSON.stringify({
      success: false,
      error: (error as Error).message,
      ...(detail ? { code, detail } : {}),
      duration: performance.now() - startTime,
      timestamp: new Date().toISOString(),
    }),
  );
}

export const getCloudAppPublishTool = createTool({
  id: "get_cloud_app_publish",
  description: `Get cloud publish status for a mini-app (apps.papr.ai).

Returns live status, slug, loginAccess, externalLink, codeAccess (off | install), requireSignIn, perUserIsolation, Community listing, URLs, and **lineage** (mode fork|track, source.slug) when installed via install_cloud_app.

If the copy is on the team's shared data (lineage.databasePolicy shared), also returns trackInstallWarning: code changes go to the owner with submit_cloud_app_pr, and shared rows sync with push_cloud_sync. A copy on its own data has no warning and publishes to its own link.

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
      // per-user → shared: tell the agent which tables everyone can now see.
      const { takeSharedExposure } = await import(
        "../../gateway/services/cloudAppPerUserIsolation.js"
      );
      const sharedExposure = takeSharedExposure(args.appId);

      const prefs = getAppPublishPrefs(args.appId);
      const sharing = resolveSharingSettings({
        loginAccess: config.loginAccess,
        externalLink: config.externalLink,
        accessMode: config.accessMode,
      });
      const codeAccess: CodeAccess = prefs.codeAccess ?? "off";
      const lineage = await readLineageForPublishTool(args.appId);
      const audiences = config.enabled ? await readAudiences(args.appId) : null;
      return {
        success: true,
        data: {
          ...appendLineageToPublishData(
            withAudiences(
              formatPublishResult(args.appId, config, sharing, codeAccess, {
                requireSignIn: prefs.requireSignIn,
                perUserIsolation: prefs.perUserIsolation,
              }),
              audiences,
            ),
            lineage,
          ),
          ...(sharedExposure
            ? {
                sharedExposure,
                sharedExposureNote:
                  "Per-user data is now ONE shared database: every signed-in user can read these tables. " +
                  "Other users' old per-user copies were not merged. Tell the user, and for tables with personal " +
                  "data call papr_db_set_table_access({ dbId, table, access: 'private' }); backfill old rows " +
                  "with a migration only if they ask.",
              }
            : {}),
        },
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

**Installed copies:** a copy on its OWN data (Community installs, per-user team apps, detached copies) publishes to its own link like any app; it never updates the original. A copy on the TEAM's shared data is refused: send code with submit_cloud_app_pr, and shared rows with push_cloud_sync. Check get_cloud_app_publish → lineage.databasePolicy.

**Preferred path for sharing** (when Cloud Sync + Papr login are on):
- **Community + fork/install:** loginAccess=public, codeAccess=install
- **Live web only:** loginAccess=public (or team/link), codeAccess=off
- **Private cloud:** loginAccess=private, externalLink=off

Access is applied through the same audiences model as the Share sheet (People with access / Public access), so changes show up there:
1. loginAccess — private | team (Workspace: Viewer) | public (Listed in Community: Viewer) | none
2. externalLink — off | read (Anyone with the link: Viewer) | read_write (Anyone with the link: Contributor). Link and Community are one "Public access" row: turning the link on with loginAccess=team turns Community off.
Listing in Community needs an approved gallery (409 community_needs_gallery otherwise).
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
      if (publishOptions.perUserIsolation === true) {
        publishOptions.requireSignIn = true;
      }

      // Captured before publishing so the event can distinguish a brand-new
      // published app from a re-publish. getPublishConfig always resolves to a
      // config object (unpublished apps come back with enabled: false), so the
      // enabled flag is the signal here, not the presence of the object.
      const wasAlreadyPublished = await publishService
        .getPublishConfig(args.appId)
        .then((prior) => prior.enabled)
        .catch(() => false);

      let config = await publishService.publishOrUpdateSharing(
        args.appId,
        publishOptions,
      );

      // Who can open the app lives in the audiences model (the Share sheet's
      // PUT /access). The legacy publish fields above are ignored by the server
      // once an app is on audiences, so apply the same change there too.
      let audiences: AudiencesAccess | null = null;
      const touchesAccess =
        args.loginAccess !== undefined ||
        args.externalLink !== undefined ||
        args.requireSignIn !== undefined;
      if (config.enabled && touchesAccess) {
        const current = await readAudiences(args.appId);
        const patch = audiencesPatchFromSharing(
          {
            loginAccess: args.loginAccess as CloudLoginAccess | undefined,
            externalLink: args.externalLink as CloudExternalLink | undefined,
            requireSignIn: publishOptions.requireSignIn,
          },
          current,
        );
        audiences = await saveAudiences(args.appId, patch, {
          current,
          hasGallery: sharedCoverKind(args.appId) === "video",
        });
        config = await publishService.getPublishConfig(args.appId);
      } else if (config.enabled) {
        audiences = await readAudiences(args.appId);
      }

      // Publishing was previously invisible in analytics: live apps could only
      // be inferred from cloud visitor traffic, so an app that was published
      // but never visited did not exist in the data. That made the
      // publish -> visitor funnel impossible to measure.
      void import("../../gateway/services/gatewayTelemetry.js")
        .then(({ getGatewayTelemetry }) => {
          getGatewayTelemetry().trackFireAndForget("paprwork_app_published", {
            app_id: args.appId,
            slug: config.slug ?? "",
            visibility: config.loginAccess ?? "unknown",
            is_first_publish: !wasAlreadyPublished,
          });
        })
        .catch(() => {});

      const prefs = getAppPublishPrefs(args.appId);
      const sharing = resolveSharingSettings({
        loginAccess: config.loginAccess,
        externalLink: config.externalLink,
        accessMode: config.accessMode,
      });
      const codeAccess: CodeAccess = prefs.codeAccess ?? args.codeAccess ?? "off";
      const lineage = await readLineageForPublishTool(args.appId);
      return {
        success: true,
        data: appendLineageToPublishData(
          withAudiences(
            formatPublishResult(args.appId, config, sharing, codeAccess, {
              requireSignIn: prefs.requireSignIn,
              perUserIsolation: prefs.perUserIsolation,
            }),
            audiences,
          ),
          lineage,
        ),
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

export const cloudPublishTools = [getCloudAppPublishTool, publishCloudAppTool];
