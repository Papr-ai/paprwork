/**
 * Cloud mini-app publish client — registers shareable URLs on the memory server.
 */

import * as fs from "fs";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import * as path from "path";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import { isCloudAutoPublishGloballyEnabled } from "./cloudAutoPublishSettings.js";
import {
  getAppPublishPrefs,
  setAppPublishPrefs,
  type CloudAccessMode,
} from "./cloudPublishPrefs.js";
import {
  accessModeToSharingSettings,
  formatShareLink,
  memoryPublishResponseToConfig,
  sharingSettingsRequireShareToken,
  resolvePublishFieldsFromPrefs,
  resolveSharingSettings,
  type CloudSharingSettings,
  type MemoryPublishResponseFields,
} from "./cloudPublishMapping.js";
import {
  detectPublishDrift,
  resolveShareTokenForConfig,
  slugifyPublishTitle,
} from "./cloudPublishDrift.js";
import {
  publishSlugRetryCandidates,
  resolveUniquePublishSlug,
  type PublishSlugCatalogEntry,
} from "../utils/uniqueAppNaming.js";
import { writeCloudAppMetadataFile } from "./cloudAppMetadataFile.js";
import { prepareCatalogIconForPublish } from "../utils/catalogIconForPublish.js";
import { normalizeCatalogTags } from "../../core/utils/catalogTags.js";
import { buildMiniApp } from "../utils/miniAppBuild.js";
import {
  catalogRequirementsForPublish,
  ensureAppRequirementsSyncedWithBackend,
} from "./cloudAppRequirements.js";
import type { RequiredKeySpec } from "../../core/types/bundles.js";
import type { CodeAccess } from "../../core/utils/shareAudienceModel.js";
import type { GitHubSyncItemsReport } from "./cloudSync/syncItemStatus.js";
import type { TursoSyncItemsReport } from "./tursoSyncStatus.js";

export interface CloudPublishConfig {
  appId: string;
  slug: string | null;
  accessMode: CloudAccessMode;
  loginAccess: CloudSharingSettings["loginAccess"];
  externalLink: CloudSharingSettings["externalLink"];
  enabled: boolean;
  shareUrl: string | null;
  publishedAt: string | null;
  shareToken?: string | null;
}

type PublishApiResponse = MemoryPublishResponseFields;

function defaultAppsHost(): string {
  return (
    process.env.PAPR_CLOUD_APPS_HOST?.replace(/\/$/, "") ??
    "https://apps.papr.ai"
  );
}

function loadAppCatalogMeta(paprDir: string): Map<
  string,
  {
    title: string;
    description: string;
    icon?: string;
    createdAt?: string;
    tags?: string[];
  }
> {
  const meta = new Map<
    string,
    {
      title: string;
      description: string;
      icon?: string;
      createdAt?: string;
      tags?: string[];
    }
  >();
  try {
    const raw = fs.readFileSync(path.join(paprDir, "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw) as
      | Array<{
          id: string;
          title?: string;
          description?: string;
          icon?: string;
          createdAt?: string;
          tags?: string[];
        }>
      | Record<
          string,
          {
            id: string;
            title?: string;
            description?: string;
            icon?: string;
            createdAt?: string;
            tags?: string[];
          }
        >;
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    for (const app of list) {
      if (app.id) {
        meta.set(app.id, {
          title: app.title?.trim() || app.id.slice(0, 8),
          description: app.description?.trim() || "",
          icon: app.icon,
          createdAt: app.createdAt,
          tags: normalizeCatalogTags(app.tags),
        });
      }
    }
  } catch {
    /* optional */
  }
  return meta;
}

async function buildPublishSlugCatalogForApp(
  appId: string,
  paprDir: string,
  fetchMemoryPublish: (targetAppId: string) => Promise<PublishApiResponse | null>,
): Promise<PublishSlugCatalogEntry[]> {
  const catalogMeta = loadAppCatalogMeta(paprDir);
  const appMeta = catalogMeta.get(appId);
  const baseSlug = slugifyPublishTitle(appMeta?.title ?? appId.slice(0, 8));

  const entries: PublishSlugCatalogEntry[] = [];
  for (const [candidateId, candidateMeta] of catalogMeta) {
    if (
      candidateId !== appId &&
      slugifyPublishTitle(candidateMeta.title) !== baseSlug
    ) {
      continue;
    }

    let memorySlug: string | null = null;
    try {
      const memory = await fetchMemoryPublish(candidateId);
      memorySlug = memory?.slug ?? null;
    } catch {
      /* ignore per-app fetch errors */
    }

    entries.push({
      appId: candidateId,
      title: candidateMeta.title,
      createdAt: candidateMeta.createdAt,
      memorySlug,
    });
  }

  if (!entries.some((entry) => entry.appId === appId)) {
    let memorySlug: string | null = null;
    try {
      const memory = await fetchMemoryPublish(appId);
      memorySlug = memory?.slug ?? null;
    } catch {
      /* ignore */
    }
    entries.push({
      appId,
      title: appMeta?.title ?? appId.slice(0, 8),
      createdAt: appMeta?.createdAt,
      memorySlug,
    });
  }

  return entries;
}

function slugifyTitle(title: string): string {
  return slugifyPublishTitle(title);
}

function expectedSlugForApp(
  appId: string,
  catalogMeta: Map<string, { title: string; description: string; icon?: string }>,
): string {
  const appMeta = catalogMeta.get(appId);
  return slugifyTitle(appMeta?.title ?? appId.slice(0, 8));
}

function buildConfigFromMemory(
  appId: string,
  data: PublishApiResponse | null,
  prefs: ReturnType<typeof getAppPublishPrefs>,
  expectedSlug: string,
): CloudPublishConfig {
  const sharing = resolveSharingSettings(prefs);
  const config = parsePublishConfig(appId, data, sharing);
  const token = resolveShareTokenForConfig(data, prefs, expectedSlug);
  if (!token) {
    return config;
  }
  const externalEnabled = sharingSettingsRequireShareToken(sharing);
  return {
    ...config,
    shareToken: token,
    shareUrl:
      formatShareLink(config.shareUrl, token, config.accessMode, externalEnabled) ??
      config.shareUrl,
  };
}

function parsePublishConfig(
  appId: string,
  data: PublishApiResponse | null,
  prefsSharing?: CloudSharingSettings,
): CloudPublishConfig {
  const base = memoryPublishResponseToConfig(appId, data);
  const sharing =
    prefsSharing ??
    accessModeToSharingSettings(base.accessMode);
  const externalEnabled = sharingSettingsRequireShareToken(sharing);
  const token = base.shareToken ?? null;
  return {
    ...base,
    loginAccess: sharing.loginAccess,
    externalLink: sharing.externalLink,
    shareToken: token,
    shareUrl:
      formatShareLink(base.shareUrl, token, base.accessMode, externalEnabled) ??
      base.shareUrl,
  };
}

export class CloudAppPublishService {
  private readonly paprDir: string;
  private autoPublishInFlight = false;

  constructor(paprDir?: string) {
    this.paprDir = paprDir ?? getPaprRoot();
  }

  private async fetchMemoryPublishResponse(
    appId: string,
  ): Promise<PublishApiResponse | null> {
    const response = await cloudApiFetch(
      `/v1/cloud/apps/publish/${encodeURIComponent(appId)}`,
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Publish config fetch failed (${response.status}): ${body.slice(0, 160)}`,
      );
    }
    return (await response.json()) as PublishApiResponse;
  }

  async republishIfPublished(appId: string): Promise<CloudPublishConfig | null> {
    const memory = await this.fetchMemoryPublishResponse(appId);
    if (!memory?.enabled) {
      return null;
    }
    return this.publishApp(appId);
  }

  /** Lightweight cloud publish check (no drift republish). */
  async getCloudPublishStatus(
    appId: string,
  ): Promise<{ published: boolean; shareUrl: string | null }> {
    try {
      const data = await this.fetchMemoryPublishResponse(appId);
      if (!data?.enabled) {
        return { published: false, shareUrl: null };
      }
      const prefs = getAppPublishPrefs(appId, this.paprDir);
      const catalogMeta = loadAppCatalogMeta(this.paprDir);
      const expectedSlug = expectedSlugForApp(appId, catalogMeta);
      const config = buildConfigFromMemory(
        appId,
        data,
        prefs,
        expectedSlug,
      );
      return {
        published: data.enabled === true,
        shareUrl: config.shareUrl,
      };
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("404") || message.includes("Not Found")) {
        return { published: false, shareUrl: null };
      }
      if (message.includes("PAPR_API_KEY")) {
        return { published: false, shareUrl: null };
      }
      throw error;
    }
  }

  private async resolveLocalCatalogRequirements(
    appId: string,
  ): Promise<RequiredKeySpec[]> {
    const { requirements } = await ensureAppRequirementsSyncedWithBackend(
      this.paprDir,
      appId,
    );
    return requirements;
  }

  async getPublishConfig(appId: string): Promise<CloudPublishConfig> {
    try {
      const catalogMeta = loadAppCatalogMeta(this.paprDir);
      const expectedSlug = expectedSlugForApp(appId, catalogMeta);
      const prefs = getAppPublishPrefs(appId, this.paprDir);
      const data = await this.fetchMemoryPublishResponse(appId);
      const localCatalogRequirements =
        await this.resolveLocalCatalogRequirements(appId);

      if (!data) {
        return parsePublishConfig(appId, null, resolveSharingSettings(prefs));
      }

      const drift = detectPublishDrift({
        memory: data,
        prefs,
        expectedSlug,
        localCatalogRequirements,
      });
      if (drift.length > 0) {
        console.log(
          `[CloudPublish] Drift for ${appId} (${drift.join(", ")}) — republishing`,
        );
        return this.publishApp(appId);
      }

      return buildConfigFromMemory(appId, data, prefs, expectedSlug);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("404") || message.includes("Not Found")) {
        const prefs = getAppPublishPrefs(appId, this.paprDir);
        return parsePublishConfig(appId, null, resolveSharingSettings(prefs));
      }
      throw error;
    }
  }

  async publishApp(
    appId: string,
    options?: {
      accessMode?: CloudAccessMode;
      loginAccess?: CloudSharingSettings["loginAccess"];
      externalLink?: CloudSharingSettings["externalLink"];
      codeAccess?: CodeAccess;
      slug?: string;
    },
  ): Promise<CloudPublishConfig> {
    const prefs = getAppPublishPrefs(appId, this.paprDir);
    const catalogMeta = loadAppCatalogMeta(this.paprDir);
    const appMeta = catalogMeta.get(appId);
    const slugCatalog = await buildPublishSlugCatalogForApp(
      appId,
      this.paprDir,
      (targetAppId) => this.fetchMemoryPublishResponse(targetAppId),
    );
    const resolvedSlug =
      options?.slug ??
      resolveUniquePublishSlug(appId, slugCatalog);
    const slugCandidates = options?.slug
      ? [options.slug]
      : publishSlugRetryCandidates(resolvedSlug);

    const codeAccess: CodeAccess =
      options?.codeAccess ?? prefs.codeAccess ?? "off";
    const sharing = resolveSharingSettings({
      loginAccess: options?.loginAccess ?? prefs.loginAccess,
      externalLink: options?.externalLink ?? prefs.externalLink,
      accessMode: options?.accessMode ?? prefs.accessMode,
    });
    const publishFields = resolvePublishFieldsFromPrefs({
      loginAccess: sharing.loginAccess,
      externalLink: sharing.externalLink,
      accessMode: options?.accessMode ?? prefs.accessMode,
      codeAccess,
    });

    const { requirements: credentialRequirements } =
      await ensureAppRequirementsSyncedWithBackend(this.paprDir, appId);

    // Build dist/app.js at publish time so apps.papr.ai serves one bundled
    // request instead of a 20-file TS module waterfall. Legacy multi-script
    // apps (no ES-module entry) skip the build and serve per-file as before.
    try {
      const appDir = path.join(this.paprDir, "apps", appId);
      const build = await buildMiniApp(appDir);
      if (!build.legacy && !build.success) {
        console.warn(
          `[CloudPublish] dist build failed for ${appId} — publishing unbundled:`,
          build.errors.slice(0, 3).map((e) => e.message).join("; "),
        );
      } else if (!build.legacy) {
        console.log(
          `[CloudPublish] Built dist bundle for ${appId}: ${build.outputFiles.join(", ")}`,
        );
      }
    } catch (error) {
      console.warn(
        `[CloudPublish] dist build errored for ${appId} — publishing unbundled:`,
        (error as Error).message,
      );
    }

    try {
      const appDir = path.join(this.paprDir, "apps", appId);
      const { buildAppBackendBundle } = await import(
        "../utils/miniAppBackendBuild.js"
      );
      const backendBundle = await buildAppBackendBundle(appDir);
      if (!backendBundle.success) {
        console.warn(
          `[CloudPublish] backend bundle failed for ${appId}:`,
          backendBundle.errors.join("; "),
        );
      } else if (backendBundle.wroteBundle) {
        console.log(
          `[CloudPublish] Built backend bundle for ${appId}: ${Object.keys(backendBundle.bundle?.actions ?? {}).join(", ")}`,
        );
      }
    } catch (error) {
      console.warn(
        `[CloudPublish] backend bundle errored for ${appId}:`,
        (error as Error).message,
      );
    }

    // Resolve App Files before talking to the publish API. If an asset would
    // ship broken this throws with the file named, so the author fixes it
    // instead of a visitor discovering it.
    await this.publishAppFiles(appId);

    await writeCloudAppMetadataFile(this.paprDir, appId);

    const appDir = path.join(this.paprDir, "apps", appId);
    const catalogIconResult = await prepareCatalogIconForPublish({
      icon: appMeta?.icon,
      appDir,
    });
    if (catalogIconResult.note) {
      console.log(`[CloudPublish] ${catalogIconResult.note}`);
    }

    const { detectCommunityPlatformForApp } = await import(
      "./cloudAppCompatibility.js"
    );
    const platformReport = await detectCommunityPlatformForApp(appId);
    console.log(
      `[CloudPublish] Local platform scan for ${appId}: ${platformReport.platform.join(", ")}` +
        (platformReport.requiresDesktopForFullFunctionality
          ? " (desktop required for full functionality)"
          : " (cloud-ready)") +
        " — memory server recomputes from GitHub repo on publish",
    );

    let response: Response | null = null;
    let lastBody = "";
    for (const slug of slugCandidates) {
      response = await cloudApiFetch("/v1/cloud/apps/publish", {
        method: "POST",
        body: {
          appId,
          slug,
          visibility: publishFields.visibility,
          linkPermission: publishFields.linkPermission,
          shareLinkEnabled: publishFields.shareLinkEnabled,
          codeAccess,
          ...(credentialRequirements.length > 0
            ? {
                catalogRequirements: catalogRequirementsForPublish(
                  credentialRequirements,
                ),
              }
            : {}),
          ...(appMeta?.title ? { catalogTitle: appMeta.title } : {}),
          ...(appMeta?.description ? { catalogDescription: appMeta.description } : {}),
          ...(catalogIconResult.icon ? { catalogIcon: catalogIconResult.icon } : {}),
          ...(appMeta?.tags?.length ? { catalogTags: appMeta.tags } : {}),
        },
      });

      if (response.ok) {
        if (slug !== resolvedSlug) {
          console.log(
            `[CloudPublish] Used fallback slug ${slug} for ${appId} (resolved ${resolvedSlug})`,
          );
        }
        break;
      }

      lastBody = await response.text();
      const isNameCollision =
        response.status === 409 &&
        lastBody.includes("already published in this namespace");
      if (!isNameCollision || slug === slugCandidates.at(-1)) {
        break;
      }
      console.warn(
        `[CloudPublish] Slug ${slug} taken for ${appId}, retrying with next candidate`,
      );
    }

    if (!response?.ok) {
      throw new Error(
        `Cloud publish failed (${response?.status ?? 0}): ${lastBody.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as PublishApiResponse;
    const config = parsePublishConfig(appId, data, sharing);
    setAppPublishPrefs(
      appId,
      {
        accessMode: config.accessMode,
        loginAccess: sharing.loginAccess,
        externalLink: sharing.externalLink,
        codeAccess,
        liveLinkPermission: publishFields.linkPermission,
        shareToken:
          sharingSettingsRequireShareToken(sharing) && config.shareToken
            ? config.shareToken
            : undefined,
        credentialRequirements,
        lastAutoPublishError: undefined,
      },
      this.paprDir,
    );

    void import("./CloudAppTrackSyncService.js")
      .then(({ getCloudAppTrackSyncService }) =>
        getCloudAppTrackSyncService().pullTrackAppsOnPublish(),
      )
      .catch((err: Error) => {
        console.warn(
          "[CloudPublish] Track pull-on-publish skipped:",
          err.message.slice(0, 120),
        );
      });

    return config;
  }

  /**
   * Make the app's publishable objects CDN-readable.
   *
   * Throws when an asset cannot be served, which aborts the publish before the
   * API call — that is the point. An app with a broken asset should not go
   * live, and the author should be told which file and why.
   */
  private async publishAppFiles(appId: string): Promise<void> {
    const { readAppFileRows } = await import("./appFiles/publishAssetReader.js");
    const rows = readAppFileRows(this.paprDir, appId);
    if (rows.length === 0) return;

    const { applyPublishVisibility } = await import(
      "./appFiles/publishAssetSync.js"
    );
    const { setVisibility } = await import("./appFiles/appFilesClient.js");

    const { plan, result } = await applyPublishVisibility(
      appId,
      rows,
      setVisibility,
    );
    console.log(
      `[CloudPublish] App Files for ${appId}: ${result.flipped.length} public, ` +
        `${plan.toKeepPrivate.length} kept private`,
    );
  }

  /**
   * Return the app's objects to private.
   *
   * Best-effort: an app must always be able to come down. A stranded public
   * object is logged loudly because it is a leak, but it cannot block the
   * unpublish it would otherwise be blocking.
   */
  private async revokeAppFiles(appId: string): Promise<void> {
    try {
      const { readAppFileRows } = await import(
        "./appFiles/publishAssetReader.js"
      );
      const rows = readAppFileRows(this.paprDir, appId);
      if (rows.length === 0) return;

      const { revokePublishVisibility } = await import(
        "./appFiles/publishAssetSync.js"
      );
      const { setVisibility } = await import("./appFiles/appFilesClient.js");

      const result = await revokePublishVisibility(appId, rows, setVisibility);
      if (result.failed.length > 0) {
        console.error(
          `[CloudPublish] ${result.failed.length} object(s) for ${appId} are STILL PUBLIC after unpublish: ` +
            result.failed.map((f) => f.objectKey).join(", "),
        );
      } else if (result.flipped.length > 0) {
        console.log(
          `[CloudPublish] Made ${result.flipped.length} App Files object(s) private for ${appId}`,
        );
      }
    } catch (error) {
      console.error(
        `[CloudPublish] App Files revoke failed for ${appId} — objects may remain public:`,
        (error as Error).message,
      );
    }
  }

  async unpublishApp(appId: string): Promise<void> {
    await this.revokeAppFiles(appId);
    const response = await cloudApiFetch(
      `/v1/cloud/apps/publish/${encodeURIComponent(appId)}`,
      { method: "DELETE" },
    );
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Cloud unpublish failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }
  }

  async listAppPublishConfigs(): Promise<CloudPublishConfig[]> {
    const catalogMeta = loadAppCatalogMeta(this.paprDir);
    const configs: CloudPublishConfig[] = [];
    for (const appId of catalogMeta.keys()) {
      try {
        configs.push(await this.getPublishConfig(appId));
      } catch (error) {
        configs.push({
          appId,
          slug: null,
          accessMode: getAppPublishPrefs(appId, this.paprDir).accessMode,
          loginAccess: resolveSharingSettings(getAppPublishPrefs(appId, this.paprDir))
            .loginAccess,
          externalLink: resolveSharingSettings(getAppPublishPrefs(appId, this.paprDir))
            .externalLink,
          enabled: false,
          shareUrl: null,
          publishedAt: null,
        });
        console.warn(
          `[CloudPublish] Failed to load config for ${appId}:`,
          (error as Error).message.slice(0, 80),
        );
      }
    }
    return configs;
  }

  /**
   * One-off backfill: build dist bundles for every already-published app so
   * existing apps get the fast bundled serving path without a manual
   * republish. Runs at most once per app version (buildMiniApp is
   * idempotent — it rebuilds only when sources are newer than dist).
   */
  async backfillDistBundles(): Promise<{ built: string[]; skipped: string[]; failed: string[] }> {
    const built: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    const configs = await this.listAppPublishConfigs();
    for (const config of configs) {
      if (!config.enabled) {
        skipped.push(config.appId);
        continue;
      }
      try {
        const appDir = path.join(this.paprDir, "apps", config.appId);
        const build = await buildMiniApp(appDir);
        const { buildAppBackendBundle } = await import(
          "../utils/miniAppBackendBuild.js"
        );
        await buildAppBackendBundle(appDir);
        if (build.legacy) {
          skipped.push(config.appId);
        } else if (build.success) {
          built.push(config.appId);
        } else {
          failed.push(config.appId);
        }
      } catch {
        failed.push(config.appId);
      }
    }

    if (built.length > 0) {
      console.log(
        `[CloudPublish] Backfilled dist bundles: ${built.join(", ")}`,
      );
    }
    return { built, skipped, failed };
  }

  isAppReadyForCloudLink(
    appId: string,
    github: GitHubSyncItemsReport,
    turso: TursoSyncItemsReport | null,
  ): boolean {
    const appPath = `apps/${appId}`;
    const githubItem = github.apps.find((item) => item.relativePath === appPath);
    if (!githubItem || githubItem.status !== "synced") {
      return false;
    }

    const tursoSources = turso?.sources.filter((s) => s.appId === appId) ?? [];
    if (tursoSources.length === 0) {
      return true;
    }
    return tursoSources.every((source) => source.status === "synced");
  }

  async isAppVerifiedReadyForCloudLink(appId: string): Promise<boolean> {
    const { getCloudSyncService } = await import("./CloudSyncService.js");
    const sync = getCloudSyncService();
    const github = sync?.getGitHubSyncItemsReport() ?? {
      workspace: [],
      apps: [],
      jobs: [],
      queuedPaths: [],
      summary: {
        synced: 0,
        pending: 0,
        outdated: 0,
        failed: 0,
        updatesAvailable: 0,
        total: 0,
      },
    };
    const { buildTursoSyncItemsReport } = await import("./tursoSyncStatus.js");
    const turso = await buildTursoSyncItemsReport(
      path.join(this.paprDir, "apps"),
      appId,
    );
    if (!this.isAppReadyForCloudLink(appId, github, turso)) {
      return false;
    }
    const { verifyAppPushConvergence } = await import(
      "./cloudSync/postPushVerify.js"
    );
    const verify = await verifyAppPushConvergence(appId, this.paprDir);
    return verify.ok;
  }

  async tryAutoPublishSyncedApps(
    github: GitHubSyncItemsReport,
    turso: TursoSyncItemsReport | null,
    options?: { syncedAppIds?: readonly string[] },
  ): Promise<void> {
    if (!isCloudAutoPublishGloballyEnabled()) {
      return;
    }
    if (this.autoPublishInFlight) {
      return;
    }
    this.autoPublishInFlight = true;

    try {
      const catalogMeta = loadAppCatalogMeta(this.paprDir);
      const candidateAppIds =
        options?.syncedAppIds && options.syncedAppIds.length > 0
          ? [...options.syncedAppIds]
          : [...catalogMeta.keys()];

      for (const appId of candidateAppIds) {
        const prefs = getAppPublishPrefs(appId, this.paprDir);
        if (prefs.autoPublish === false) {
          continue;
        }
        if (!this.isAppReadyForCloudLink(appId, github, turso)) {
          continue;
        }
        if (!(await this.isAppVerifiedReadyForCloudLink(appId))) {
          console.warn(
            `[CloudPublish] Skipping auto-publish for ${appId}: post-push verify not passed`,
          );
          continue;
        }

        let memory: PublishApiResponse | null;
        try {
          memory = await this.fetchMemoryPublishResponse(appId);
        } catch (error) {
          setAppPublishPrefs(
            appId,
            {
              lastAutoPublishAttemptAt: new Date().toISOString(),
              lastAutoPublishError: (error as Error).message.slice(0, 160),
            },
            this.paprDir,
          );
          continue;
        }

        const expectedSlug = expectedSlugForApp(appId, catalogMeta);
        const localCatalogRequirements =
          await this.resolveLocalCatalogRequirements(appId);
        const drift = detectPublishDrift({
          memory,
          prefs,
          expectedSlug,
          localCatalogRequirements,
        });
        const needsInitialPublish = !memory?.enabled || !memory.shareUrl;

        if (!needsInitialPublish && drift.length === 0) {
          continue;
        }

        try {
          const published = await this.publishApp(appId);
          setAppPublishPrefs(
            appId,
            {
              lastAutoPublishAttemptAt: new Date().toISOString(),
              lastAutoPublishError: undefined,
            },
            this.paprDir,
          );
          const action = needsInitialPublish ? "Auto-published" : "Re-published (drift)";
          console.log(
            `[CloudPublish] ${action} ${appId} → ${published.shareUrl ?? defaultAppsHost()}`,
          );
        } catch (error) {
          const message = (error as Error).message;
          if (message.includes("404") || message.includes("Not Found")) {
            return;
          }
          setAppPublishPrefs(
            appId,
            {
              lastAutoPublishAttemptAt: new Date().toISOString(),
              lastAutoPublishError: message.slice(0, 160),
            },
            this.paprDir,
          );
          console.warn(
            `[CloudPublish] Auto-publish failed for ${appId}:`,
            message.slice(0, 120),
          );
        }
      }
    } finally {
      this.autoPublishInFlight = false;
    }
  }
}

let instance: CloudAppPublishService | null = null;

export function getCloudAppPublishService(): CloudAppPublishService {
  if (!instance) {
    instance = new CloudAppPublishService();
  }
  return instance;
}
