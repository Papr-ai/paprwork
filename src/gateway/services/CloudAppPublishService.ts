/**
 * Cloud mini-app publish client — registers shareable URLs on the memory server.
 */

import * as fs from "fs";
import { readSharedCoverPointer, type SharedCoverPointer } from "./appCovers.js";
import type { CatalogMediaItem } from "../../core/types/communityCatalog.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import * as path from "path";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import {
  formatCloudPublishFailureMessage,
  reportPaprQuotaError,
} from "../../core/utils/paprQuota.js";
import {
  canPerformWorkspaceWrite,
  getWorkspaceWriteGeneration,
  WorkspaceWriteBlockedError,
} from "./workspaceWriteGuard.js";
import { isCloudAutoPublishGloballyEnabled } from "./cloudAutoPublishSettings.js";
import {
  getAppPublishPrefs,
  loadCloudPublishPrefs,
  mergeAutoPublishCandidateAppIds,
  needsPublishRecovery,
  setAppPublishPrefs,
  type AutoPublishCandidateScope,
  type CloudAccessMode,
} from "./cloudPublishPrefs.js";
import {
  accessModeToSharingSettings,
  formatShareLink,
  memoryPublishResponseToConfig,
  memoryPublishResponseToSharingSettings,
  resolvePublishFieldsFromMemory,
  resolvePublishFieldsFromPrefs,
  resolvePublishFieldsWhenPreservingCloudSharing,
  mergePublishPrefsForFields,
  sharingSettingsRequireShareToken,
  resolveSharingSettings,
  type CloudSharingSettings,
  type MemoryPublishResponseFields,
} from "./cloudPublishMapping.js";
import { memoryShareAllowlistBodyFromPrefs } from "./cloudShareAllowlistMemory.js";
import { scheduleCloudAppHostAccessInvalidation } from "./cloudAppPublishAllowlistSync.js";
import {
  detectAutoPublishDrift,
  codeAccessPatchFromMemory,
  resolveShareTokenForConfig,
  resolveSharingSettingsForDisplay,
  slugifyPublishTitle,
  type PublishDriftInput,
} from "./cloudPublishDrift.js";
import {
  linkedCopyPublishSlug,
  personalSlugHandle,
  publishSlugRetryCandidates,
  resolveUniquePublishSlug,
  type PublishSlugCatalogEntry,
} from "../utils/uniqueAppNaming.js";
import { writeCloudAppMetadataFile } from "./cloudAppMetadataFile.js";
import { prepareCatalogIconForPublish } from "../utils/catalogIconForPublish.js";
import type { CatalogAutomation } from "../../core/types/catalogAutomation.js";
import { resolveCatalogAutomationForApp } from "./cloudCatalogAutomation.js";
import { getAppCategoryService } from "./AppCategoryService.js";

/** The app's broad category (Jev or user-picked) for Team/Community pills. */
function publishCategory(appId: string): string | undefined {
  try {
    return getAppCategoryService().categoryFor(`app:${appId}`) ?? undefined;
  } catch {
    return undefined;
  }
}
import { normalizeCatalogTags } from "../../core/utils/catalogTags.js";
import { buildMiniApp, MiniAppDistBuildError } from "../utils/miniAppBuild.js";
import {
  checkAppKeyDeclarations,
  catalogRequirementsForPublish,
  ensureAppRequirementsSyncedWithBackend,
} from "./cloudAppRequirements.js";
import type { RequiredKeySpec } from "../../core/types/bundles.js";
import type { CodeAccess } from "../../core/utils/shareAudienceModel.js";
import type { GitHubSyncItemsReport } from "./cloudSync/syncItemStatus.js";
import type { TursoSyncItemsReport } from "./tursoSyncStatus.js";
import {
  isCloudCatalogLightSyncEnabled,
  publishIntentTimeoutMs,
  type CloudPublishIntent,
} from "../../core/types/cloudPublishIntent.js";
import {
  readPlatformCatalogManifest,
  reconcilePlatformCatalogManifest,
} from "./syncV3/platformCatalogManifest.js";
import { withPublishInFlight } from "./cloudPublishInFlight.js";
import { getCloudAppLineageService } from "./CloudAppLineageService.js";
import { getGatewayPaprProfile } from "../utils/paprGatewayProfile.js";
import { isOnTeamData } from "../../core/utils/copyAxes.js";

/** A copy on the team's live data ships code only through proposals (v5). */

/**
 * Listing media for the catalog record. Today: the owner's shared cover (papr-cover.json)
 * as the single role=cover item; a details-page gallery appends role=gallery items later.
 * [] clears a previously stored cover once sharing stops (memory replaces the whole list).
 */
export function sharedCoverCatalogFields(appId: string): { catalogMedia: CatalogMediaItem[] } {
  const p = readSharedCoverPointer(appId) as
    | (SharedCoverPointer & {
        kind?: string;
        videoUrl?: string;
        videoObjectKey?: string;
        gallery?: { objectKey?: string; caption?: string }[];
        dark?: { objectKey?: string; videoObjectKey?: string; gallery?: { objectKey?: string; caption?: string }[] };
      })
    | null;
  const media: CatalogMediaItem[] = [];
  // References, not links: memory serves them under the app's own access rules, so private and
  // team apps keep their media private and nothing public has to be minted.
  if (p?.kind === "video" && p.videoObjectKey && p.objectKey) {
    media.push({ kind: "video", role: "cover", objectKey: p.videoObjectKey, posterObjectKey: p.objectKey });
  } else if (p?.objectKey) {
    media.push({ kind: "image", role: "cover", objectKey: p.objectKey });
  }
  // Light first (older clients and the web page read the first cover); dark items carry scheme "dark".
  const d = p?.kind === "video" ? p.dark : undefined;
  if (d?.videoObjectKey && d.objectKey) {
    media.push({ kind: "video", role: "cover", scheme: "dark", objectKey: d.videoObjectKey, posterObjectKey: d.objectKey });
  }
  for (const g of p?.kind === "video" && Array.isArray(p.gallery) ? p.gallery : []) {
    if (g?.objectKey) media.push({ kind: "image", role: "gallery", objectKey: g.objectKey, ...(g.caption ? { alt: g.caption } : {}) });
  }
  for (const g of Array.isArray(d?.gallery) ? d!.gallery! : []) {
    if (g?.objectKey) media.push({ kind: "image", role: "gallery", scheme: "dark", objectKey: g.objectKey, ...(g.caption ? { alt: g.caption } : {}) });
  }
  return { catalogMedia: media };
}

export class TeamDataCopyPublishError extends Error {
  constructor(appId: string) {
    super(
      `App ${appId} is a copy on the team's live data. Its code reaches the team only through a proposal; ` +
        "switch to your own data to publish it to its own link.",
    );
    this.name = "TeamDataCopyPublishError";
  }
}

async function copyIsOnTeamData(appId: string): Promise<boolean> {
  try {
    return isOnTeamData(await getCloudAppLineageService().readLineageForApp(appId));
  } catch {
    return false;
  }
}
import { coerceRequireSignInForPerUserIsolation } from "./appRuntime/cloudAppPerUserAccess.js";

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
    headline?: string;
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
      headline?: string;
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
          headline?: string;
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
            headline?: string;
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
          headline: app.headline?.trim() || "",
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

function buildConfigFromMemory(
  appId: string,
  data: PublishApiResponse | null,
  prefs: ReturnType<typeof getAppPublishPrefs>,
  expectedSlug: string,
): CloudPublishConfig {
  const sharing = resolveSharingSettingsForDisplay(prefs, data);
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

/**
 * Publish status changes only when someone publishes/unpublishes, so it is not
 * re-asked on every UI refresh (each refresh resolved slugs across sibling apps:
 * ~4 GET /publish/{id} per unpublished app every 5 minutes, all 404).
 * "Not published" is kept 1h; a live record 30s (collapses one refresh's burst).
 * This desktop's own publish/unpublish clears the entry; other devices' changes
 * show within the TTL, or at once via invalidatePublishStatusCache.
 */
const PUBLISH_STATUS_NOT_FOUND_TTL_MS = 60 * 60 * 1000;
const PUBLISH_STATUS_FOUND_TTL_MS = 30 * 1000;
const publishStatusCache = new Map<
  string,
  { expiresAt: number; value: Promise<PublishApiResponse | null> }
>();

export function invalidatePublishStatusCache(appId?: string): void {
  if (appId) publishStatusCache.delete(appId);
  else publishStatusCache.clear();
}

export class CloudAppPublishService {
  private readonly boundPaprDir: string;
  private readonly boundWriteGeneration: number;
  private autoPublishInFlight = false;

  constructor(paprDir?: string) {
    this.boundPaprDir = paprDir ?? getPaprRoot();
    this.boundWriteGeneration = getWorkspaceWriteGeneration();
  }

  private get paprDir(): string {
    return this.boundPaprDir;
  }

  private isWriteAllowed(context: string): boolean {
    return canPerformWorkspaceWrite(
      this.boundWriteGeneration,
      this.paprDir,
      context,
    );
  }

  private fetchMemoryPublishResponse(
    appId: string,
  ): Promise<PublishApiResponse | null> {
    const hit = publishStatusCache.get(appId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = this.fetchMemoryPublishResponseUncached(appId);
    // Concurrent callers share one request; errors are never cached.
    publishStatusCache.set(appId, { expiresAt: Date.now() + PUBLISH_STATUS_FOUND_TTL_MS, value });
    value.then(
      (data) => {
        if (publishStatusCache.get(appId)?.value !== value) return;
        const ttl = data ? PUBLISH_STATUS_FOUND_TTL_MS : PUBLISH_STATUS_NOT_FOUND_TTL_MS;
        publishStatusCache.set(appId, { expiresAt: Date.now() + ttl, value });
      },
      () => {
        if (publishStatusCache.get(appId)?.value === value) publishStatusCache.delete(appId);
      },
    );
    return value;
  }

  private async fetchMemoryPublishResponseUncached(
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

  /** Same slug resolution as publishApp — avoids false drift on disambiguated slugs. */
  private async resolveExpectedPublishSlug(appId: string): Promise<string> {
    const slugCatalog = await buildPublishSlugCatalogForApp(
      appId,
      this.paprDir,
      (targetAppId) => this.fetchMemoryPublishResponse(targetAppId),
    );
    return resolveUniquePublishSlug(appId, slugCatalog);
  }

  private async resolveLocalCatalogMetadata(
    appId: string,
  ): Promise<NonNullable<PublishDriftInput["localCatalogMetadata"]>> {
    const catalogMeta = loadAppCatalogMeta(this.paprDir);
    const appMeta = catalogMeta.get(appId);
    const appDir = path.join(this.paprDir, "apps", appId);
    let manifest = await readPlatformCatalogManifest(appDir);
    if (!manifest) {
      manifest = await reconcilePlatformCatalogManifest(this.paprDir, appId);
    }
    return {
      title: appMeta?.title,
      description: appMeta?.description,
      icon: appMeta?.icon,
      tags: appMeta?.tags,
      platform: manifest.platform,
      requiresDesktop: manifest.requiresDesktopForFullFunctionality,
    };
  }

  /** Sync App Files CDN visibility for a live app (no Mongo publish). */
  async syncLiveAppArtifacts(appId: string): Promise<void> {
    await this.publishAppFiles(appId);
  }

  /**
   * Lightweight catalog metadata sync when local prefs/manifest drift from Mongo.
   * Returns updated config when drift was repaired; null when already aligned.
   */
  async syncCatalogIfDrift(appId: string): Promise<CloudPublishConfig | null> {
    const memory = await this.fetchMemoryPublishResponse(appId);
    if (!memory?.enabled) {
      return null;
    }

    const prefs = getAppPublishPrefs(appId, this.paprDir);
    const expectedSlug = await this.resolveExpectedPublishSlug(appId);
    const localCatalogRequirements =
      await this.resolveLocalCatalogRequirements(appId);
    const localCatalogMetadata = await this.resolveLocalCatalogMetadata(appId);
    const localCatalogAutomation = await resolveCatalogAutomationForApp(appId);
    const drift = detectAutoPublishDrift({
      memory,
      prefs,
      expectedSlug,
      localCatalogRequirements,
      localCatalogMetadata,
      localCatalogAutomation,
    });

    if (drift.length === 0) {
      return null;
    }

    console.log(
      `[CloudPublish] Catalog drift for ${appId} (${drift.join(", ")}) — intent:catalog`,
    );

    return this.updateCatalogMetadata(appId, { preserveCloudSharing: true });
  }

  /** Update Mongo publish record metadata only (intent: catalog). */
  async updateCatalogMetadata(
    appId: string,
    options?: { preserveCloudSharing?: boolean; slug?: string },
  ): Promise<CloudPublishConfig> {
    if (!this.isWriteAllowed(`updateCatalogMetadata ${appId}`)) {
      throw new WorkspaceWriteBlockedError(
        `Blocked updateCatalogMetadata ${appId}`,
      );
    }

    const prefs = getAppPublishPrefs(appId, this.paprDir);
    const catalogMeta = loadAppCatalogMeta(this.paprDir);
    const appMeta = catalogMeta.get(appId);
    const expectedSlug = await this.resolveExpectedPublishSlug(appId);
    const resolvedSlug = options?.slug ?? expectedSlug;

    const liveMemory = await this.fetchMemoryPublishResponse(appId);
    const sharing =
      options?.preserveCloudSharing && liveMemory?.enabled
        ? memoryPublishResponseToSharingSettings(liveMemory)
        : resolveSharingSettings(prefs);
    const publishFields =
      options?.preserveCloudSharing && liveMemory?.enabled
        ? resolvePublishFieldsWhenPreservingCloudSharing(liveMemory, prefs)
        : resolvePublishFieldsFromPrefs(mergePublishPrefsForFields(prefs));
    const codeAccess: CodeAccess =
      (options?.preserveCloudSharing && liveMemory?.enabled
        ? liveMemory.codeAccess
        : prefs.codeAccess) ?? "off";

    const { requirements: credentialRequirements } =
      await ensureAppRequirementsSyncedWithBackend(this.paprDir, appId);

    const appDir = path.join(this.paprDir, "apps", appId);
    let manifest = await readPlatformCatalogManifest(appDir);
    if (!manifest) {
      manifest = await reconcilePlatformCatalogManifest(this.paprDir, appId);
    }

    const catalogIconResult = await prepareCatalogIconForPublish({
      icon: appMeta?.icon,
      appDir,
    });

    const catalogAutomation = await resolveCatalogAutomationForApp(appId);

    const data = await this.postPublishToMemory(appId, resolvedSlug, {
      intent: "catalog",
      skipPlatformScan: true,
      visibility: publishFields.visibility,
      linkPermission: publishFields.linkPermission,
      shareLinkEnabled: publishFields.shareLinkEnabled,
      requireSignIn: publishFields.requireSignIn,
      communityCatalogListed: publishFields.communityCatalogListed,
      codeAccess,
      catalogPlatform: manifest.platform,
      catalogRequiresDesktop: manifest.requiresDesktopForFullFunctionality,
      credentialRequirements,
      catalogTitle: appMeta?.title,
      catalogDescription: appMeta?.description,
      catalogIcon: catalogIconResult.icon,
      catalogTags: appMeta?.tags,
      catalogHeadline: appMeta?.headline,
      ...sharedCoverCatalogFields(appId),
      catalogCategory: publishCategory(appId),
      catalogAutomation,
      shareAllowlist: memoryShareAllowlistBodyFromPrefs(prefs),
    });

    const config = parsePublishConfig(appId, data, sharing);
    setAppPublishPrefs(
      appId,
      {
        credentialRequirements,
        lastAutoPublishError: undefined,
      },
      this.paprDir,
    );
    scheduleCloudAppHostAccessInvalidation(
      this.paprDir,
      appId,
      config,
      getAppPublishPrefs(appId, this.paprDir),
    );
    return config;
  }

  /** Update sharing ACL fields only (intent: sharing). */
  async updateSharing(
    appId: string,
    options?: {
      accessMode?: CloudAccessMode;
      loginAccess?: CloudSharingSettings["loginAccess"];
      externalLink?: CloudSharingSettings["externalLink"];
      codeAccess?: CodeAccess;
      requireSignIn?: boolean;
      perUserIsolation?: boolean;
    },
  ): Promise<CloudPublishConfig | null> {
    const memory = await this.fetchMemoryPublishResponse(appId);
    if (!memory?.enabled) {
      return null;
    }

    if (!this.isWriteAllowed(`updateSharing ${appId}`)) {
      throw new WorkspaceWriteBlockedError(`Blocked updateSharing ${appId}`);
    }

    const prefs = getAppPublishPrefs(appId, this.paprDir);
    const expectedSlug = await this.resolveExpectedPublishSlug(appId);

    const sharing = resolveSharingSettings({
      loginAccess: options?.loginAccess ?? prefs.loginAccess,
      externalLink: options?.externalLink ?? prefs.externalLink,
      accessMode: options?.accessMode ?? prefs.accessMode,
    });
    const codeAccess = options?.codeAccess ?? prefs.codeAccess ?? "off";
    const perUserIsolation =
      options?.perUserIsolation !== undefined
        ? options.perUserIsolation
        : prefs.perUserIsolation;
    const requireSignIn = coerceRequireSignInForPerUserIsolation(
      perUserIsolation,
      options?.requireSignIn !== undefined
        ? options.requireSignIn
        : prefs.requireSignIn,
    );
    const publishFields = resolvePublishFieldsFromPrefs(
      mergePublishPrefsForFields(prefs, {
        loginAccess: sharing.loginAccess,
        externalLink: sharing.externalLink,
        accessMode: options?.accessMode ?? prefs.accessMode,
        codeAccess,
        requireSignIn,
      }),
    );

    if (perUserIsolation !== undefined) {
      const { applyPerUserIsolationForApp } = await import(
        "./cloudAppPerUserIsolation.js"
      );
      await applyPerUserIsolationForApp(appId, perUserIsolation, this.paprDir);
    }

    if (perUserIsolation === true) {
      const { validatePerUserIsolationForPublish } = await import(
        "./cloudAppPerUserIsolation.js"
      );
      const validation = await validatePerUserIsolationForPublish(appId, this.paprDir);
      if (!validation.ok) {
        throw new Error(validation.error);
      }
    }

    {
      const { assertPrivateTablesPublishable } = await import("./privateTablePublishGate.js");
      await assertPrivateTablesPublishable(path.join(this.paprDir, "apps", appId));
    }

    const data = await this.postPublishToMemory(appId, memory.slug ?? expectedSlug, {
      intent: "sharing",
      skipPlatformScan: true,
      visibility: publishFields.visibility,
      linkPermission: publishFields.linkPermission,
      shareLinkEnabled: publishFields.shareLinkEnabled,
      requireSignIn: publishFields.requireSignIn,
      communityCatalogListed: publishFields.communityCatalogListed,
      codeAccess,
      shareAllowlist: memoryShareAllowlistBodyFromPrefs(prefs),
    });

    const config = parsePublishConfig(appId, data, sharing);
    const shareTokenFromPublish =
      sharingSettingsRequireShareToken(sharing) && config.shareToken
        ? config.shareToken
        : undefined;
    setAppPublishPrefs(
      appId,
      {
        accessMode: config.accessMode,
        loginAccess: sharing.loginAccess,
        externalLink: sharing.externalLink,
        codeAccess,
        requireSignIn: publishFields.requireSignIn ?? false,
        liveLinkPermission: publishFields.linkPermission,
        ...(shareTokenFromPublish ? { shareToken: shareTokenFromPublish } : {}),
        ...(perUserIsolation !== undefined ? { perUserIsolation } : {}),
      },
      this.paprDir,
    );
    scheduleCloudAppHostAccessInvalidation(
      this.paprDir,
      appId,
      config,
      prefs,
    );
    return config;
  }

  /**
   * Live app + sharing fields → memory intent:sharing (fast ACL).
   * First register or slug change → full publishApp (intent:register).
   */
  async publishOrUpdateSharing(
    appId: string,
    options?: {
      accessMode?: CloudAccessMode;
      loginAccess?: CloudSharingSettings["loginAccess"];
      externalLink?: CloudSharingSettings["externalLink"];
      codeAccess?: CodeAccess;
      requireSignIn?: boolean;
      perUserIsolation?: boolean;
      slug?: string;
      preserveCloudSharing?: boolean;
    },
  ): Promise<CloudPublishConfig> {
    const memory = await this.fetchMemoryPublishResponse(appId);
    const hasExplicitSharing =
      options?.accessMode !== undefined ||
      options?.loginAccess !== undefined ||
      options?.externalLink !== undefined ||
      options?.codeAccess !== undefined ||
      options?.requireSignIn !== undefined ||
      options?.perUserIsolation !== undefined;

    if (memory?.enabled && hasExplicitSharing && !options?.slug) {
      const updated = await this.updateSharing(appId, options);
      if (updated) {
        return updated;
      }
    }
    return this.publishApp(appId, options);
  }

  private async postPublishToMemory(
    appId: string,
    slug: string,
    body: {
      intent?: CloudPublishIntent;
      skipPlatformScan?: boolean;
      visibility: ReturnType<typeof resolvePublishFieldsFromPrefs>["visibility"];
      linkPermission: ReturnType<
        typeof resolvePublishFieldsFromPrefs
      >["linkPermission"];
      shareLinkEnabled?: boolean;
      requireSignIn?: boolean;
      communityCatalogListed?: boolean;
      codeAccess: CodeAccess;
      catalogPlatform?: string[];
      catalogRequiresDesktop?: boolean;
      credentialRequirements?: RequiredKeySpec[];
      catalogTitle?: string;
      catalogDescription?: string;
      catalogIcon?: string;
      catalogTags?: string[];
      catalogCategory?: string;
      /** "" clears; undefined leaves the published headline as is. */
      catalogHeadline?: string;
      /** Listing media (cover + gallery). [] clears; undefined leaves as is. */
      catalogMedia?: CatalogMediaItem[];
      catalogAutomation?: CatalogAutomation | null;
      shareAllowlist?: ReturnType<typeof memoryShareAllowlistBodyFromPrefs>;
    },
  ): Promise<PublishApiResponse> {
    if (!this.isWriteAllowed(`postPublishToMemory ${appId}`)) {
      throw new WorkspaceWriteBlockedError(
        `Blocked postPublishToMemory ${appId}`,
      );
    }

    const intent = body.intent ?? "register";
    const timeoutMs = publishIntentTimeoutMs(intent);

    invalidatePublishStatusCache(appId);
    return withPublishInFlight(appId, async () => {
      const response = await cloudApiFetch("/v1/cloud/apps/publish", {
        method: "POST",
        timeoutMs,
        body: {
          appId,
          slug,
          visibility: body.visibility,
          linkPermission: body.linkPermission,
          shareLinkEnabled: body.shareLinkEnabled,
          ...(body.visibility === "public_read"
            ? { requireSignIn: body.requireSignIn === true }
            : body.requireSignIn
              ? { requireSignIn: true }
              : {}),
          ...(body.communityCatalogListed !== undefined
            ? { communityCatalogListed: body.communityCatalogListed }
            : {}),
          codeAccess: body.codeAccess,
          intent,
          // Memory hides a first publish from catalogs until markPublishComplete
          // reports the commit that landed (older servers ignore the field).
          ...(intent === "register" ? { trackCompletion: true } : {}),
          skipPlatformScan: body.skipPlatformScan === true,
          ...(body.credentialRequirements && body.credentialRequirements.length > 0
            ? {
                catalogRequirements: catalogRequirementsForPublish(
                  body.credentialRequirements,
                ),
              }
            : {}),
          ...(body.catalogTitle ? { catalogTitle: body.catalogTitle } : {}),
          ...(body.catalogDescription
            ? { catalogDescription: body.catalogDescription }
            : {}),
          ...(body.catalogIcon ? { catalogIcon: body.catalogIcon } : {}),
          ...(body.catalogTags?.length ? { catalogTags: body.catalogTags } : {}),
          ...(body.catalogCategory ? { catalogCategory: body.catalogCategory } : {}),
          ...(body.catalogHeadline !== undefined ? { catalogHeadline: body.catalogHeadline } : {}),
          ...(body.catalogMedia !== undefined ? { catalogMedia: body.catalogMedia } : {}),
          ...(body.catalogPlatform?.length
            ? { catalogPlatform: body.catalogPlatform }
            : {}),
          ...(body.catalogRequiresDesktop !== undefined
            ? { catalogRequiresDesktop: body.catalogRequiresDesktop }
            : {}),
          ...(body.catalogAutomation !== undefined
            ? { catalogAutomation: body.catalogAutomation }
            : {}),
          ...(body.shareAllowlist
            ? {
                allowedUserIds: body.shareAllowlist.allowedUserIds,
                allowedEmails: body.shareAllowlist.allowedEmails,
                allowedEmailDomains: body.shareAllowlist.allowedEmailDomains,
              }
            : {}),
        },
      });

      if (!response.ok) {
        const lastBody = await response.text();
        reportPaprQuotaError(
          new Error(`Cloud publish failed (${response.status}): ${lastBody}`),
          "cloud-publish",
        );
        throw new Error(
          formatCloudPublishFailureMessage(lastBody, response.status),
        );
      }

      invalidatePublishStatusCache(appId);
      return (await response.json()) as PublishApiResponse;
    });
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
      const expectedSlug = await this.resolveExpectedPublishSlug(appId);
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
      const data = await this.fetchMemoryPublishResponse(appId);
      const prefs = getAppPublishPrefs(appId, this.paprDir);
      const expectedSlug = await this.resolveExpectedPublishSlug(appId);

      if (!data) {
        return parsePublishConfig(appId, null, resolveSharingSettings(prefs));
      }

      const codePatch = codeAccessPatchFromMemory(prefs, data);
      const effectivePrefs = codePatch
        ? setAppPublishPrefs(appId, codePatch, this.paprDir)
        : prefs;
      return buildConfigFromMemory(appId, data, effectivePrefs, expectedSlug);
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
      requireSignIn?: boolean;
      perUserIsolation?: boolean;
      slug?: string;
      /** Code/catalog refresh only — keep ACL fields from the live cloud publish record. */
      preserveCloudSharing?: boolean;
      /** Background auto-republish (no agent attached). */
      background?: boolean;
    },
  ): Promise<CloudPublishConfig> {
    if (!this.isWriteAllowed(`publishApp ${appId}`)) {
      throw new WorkspaceWriteBlockedError(`Blocked publishApp ${appId}`);
    }
    if (await copyIsOnTeamData(appId)) {
      throw new TeamDataCopyPublishError(appId);
    }
    const prefs = getAppPublishPrefs(appId, this.paprDir);
    const catalogMeta = loadAppCatalogMeta(this.paprDir);
    const appMeta = catalogMeta.get(appId);
    const slugCatalog = await buildPublishSlugCatalogForApp(
      appId,
      this.paprDir,
      (targetAppId) => this.fetchMemoryPublishResponse(targetAppId),
    );
    // A linked copy never takes the original's link (same namespace → 409 every time);
    // it publishes as "<slug>-<your name>" instead.
    const lineage = await getCloudAppLineageService().readLineageForApp(appId).catch(() => null);
    const resolvedSlug =
      options?.slug ??
      linkedCopyPublishSlug(
        resolveUniquePublishSlug(appId, slugCatalog),
        lineage?.sourceSlug,
        personalSlugHandle(getGatewayPaprProfile()),
      );
    const slugCandidates = options?.slug
      ? [options.slug]
      : publishSlugRetryCandidates(resolvedSlug);

    const hasExplicitSharing =
      options?.accessMode !== undefined ||
      options?.loginAccess !== undefined ||
      options?.externalLink !== undefined ||
      options?.codeAccess !== undefined ||
      options?.requireSignIn !== undefined;

    const liveMemory =
      options?.preserveCloudSharing && !hasExplicitSharing
        ? await this.fetchMemoryPublishResponse(appId)
        : null;

    let sharing: CloudSharingSettings;
    let codeAccess: CodeAccess;
    let publishFields: ReturnType<typeof resolvePublishFieldsFromPrefs>;
    let requireSignIn: boolean | undefined;

    if (hasExplicitSharing) {
      sharing = resolveSharingSettings({
        loginAccess: options?.loginAccess ?? prefs.loginAccess,
        externalLink: options?.externalLink ?? prefs.externalLink,
        accessMode: options?.accessMode ?? prefs.accessMode,
      });
      codeAccess = options?.codeAccess ?? prefs.codeAccess ?? "off";
      requireSignIn =
        options?.requireSignIn !== undefined
          ? options.requireSignIn
          : prefs.requireSignIn;
      publishFields = resolvePublishFieldsFromPrefs(
        mergePublishPrefsForFields(prefs, {
          loginAccess: sharing.loginAccess,
          externalLink: sharing.externalLink,
          accessMode: options?.accessMode ?? prefs.accessMode,
          codeAccess,
          requireSignIn,
        }),
      );
    } else if (liveMemory?.enabled) {
      const fromMemory = resolvePublishFieldsFromMemory(liveMemory);
      sharing = memoryPublishResponseToSharingSettings(liveMemory);
      codeAccess = fromMemory.codeAccess;
      const preserved = resolvePublishFieldsWhenPreservingCloudSharing(
        liveMemory,
        prefs,
      );
      requireSignIn = preserved.requireSignIn;
      publishFields = preserved;
    } else {
      sharing = resolveSharingSettings({
        loginAccess: prefs.loginAccess,
        externalLink: prefs.externalLink,
        accessMode: prefs.accessMode,
      });
      codeAccess = prefs.codeAccess ?? "off";
      requireSignIn = prefs.requireSignIn;
      publishFields = resolvePublishFieldsFromPrefs(
        mergePublishPrefsForFields(prefs, {
          loginAccess: sharing.loginAccess,
          externalLink: sharing.externalLink,
          codeAccess,
          requireSignIn,
        }),
      );
    }

    const perUserIsolation =
      options?.perUserIsolation !== undefined
        ? options.perUserIsolation
        : prefs.perUserIsolation;

    if (perUserIsolation === true && requireSignIn !== true) {
      requireSignIn = true;
      if (hasExplicitSharing) {
        publishFields = resolvePublishFieldsFromPrefs(
          mergePublishPrefsForFields(prefs, {
            loginAccess: sharing.loginAccess,
            externalLink: sharing.externalLink,
            accessMode: options?.accessMode ?? prefs.accessMode,
            codeAccess,
            requireSignIn: true,
          }),
        );
      }
    }

    if (perUserIsolation !== undefined) {
      const { applyPerUserIsolationForApp } = await import(
        "./cloudAppPerUserIsolation.js"
      );
      await applyPerUserIsolationForApp(appId, perUserIsolation, this.paprDir);
    }

    if (perUserIsolation === true) {
      const { validatePerUserIsolationForPublish } = await import(
        "./cloudAppPerUserIsolation.js"
      );
      const validation = await validatePerUserIsolationForPublish(appId, this.paprDir);
      if (!validation.ok) {
        throw new Error(validation.error);
      }
    }

    {
      const { assertPrivateTablesPublishable } = await import("./privateTablePublishGate.js");
      await assertPrivateTablesPublishable(path.join(this.paprDir, "apps", appId));
    }

    const {
      reconcileAppDataSourcesForPublish,
      validatePublishBundleIntegrity,
      detectCrossAppDependencies,
      writeCloudAppDependenciesFile,
    } = await import("./cloudAppResourceIntegrity.js");
    const reconcileReport = await reconcileAppDataSourcesForPublish(
      this.paprDir,
      appId,
    );
    if (reconcileReport.changed) {
      console.log(
        `[CloudPublish] Reconciled data-sources for ${appId} before publish`,
      );
    }
    const integrity = await validatePublishBundleIntegrity(this.paprDir, appId);
    if (!integrity.ok) {
      throw new Error(
        `Publish blocked — bundle integrity check failed: ${integrity.errors.slice(0, 3).join("; ")}`,
      );
    }
    if (integrity.warnings.length > 0) {
      console.warn(
        `[CloudPublish] Bundle warnings for ${appId}:`,
        integrity.warnings.slice(0, 3).join(" | "),
      );
    }
    await writeCloudAppDependenciesFile(
      this.paprDir,
      appId,
      await detectCrossAppDependencies(this.paprDir, appId),
    );

    // Undeclared keys never block publish: existing apps predate declaring.
    // validate_app is where the agent fixes them; until then they publish as
    // owner keys, which visitors are never asked for.
    try {
      const undeclared = await checkAppKeyDeclarations(this.paprDir, appId);
      if (undeclared.length > 0) {
        console.warn(
          `[CloudPublish] ${appId}: ${undeclared.length} undeclared key(s) published as owner keys: ${undeclared.map((key) => key.name).join(", ")}`,
        );
      }
    } catch {
      // advisory only
    }

    if (
      options?.preserveCloudSharing &&
      !hasExplicitSharing &&
      isCloudCatalogLightSyncEnabled()
    ) {
      return this.updateCatalogMetadata(appId, {
        preserveCloudSharing: true,
        slug: options?.slug,
      });
    }

    const { requirements: credentialRequirements } =
      await ensureAppRequirementsSyncedWithBackend(this.paprDir, appId);

    const appDir = path.join(this.paprDir, "apps", appId);
    const lightSync = isCloudCatalogLightSyncEnabled();

    if (lightSync) {
      const { prepareAppForCloudGitSync } = await import(
        "./cloudSync/prepareAppsForCloud.js"
      );
      await prepareAppForCloudGitSync(this.paprDir, appId, { strictBuild: true });
    } else {
      try {
        const build = await buildMiniApp(appDir);
        if (!build.legacy && !build.success) {
          throw new MiniAppDistBuildError(appId, build.errors);
        } else if (!build.legacy) {
          console.log(
            `[CloudPublish] Built dist bundle for ${appId}: ${build.outputFiles.join(", ")}`,
          );
        }
      } catch (error) {
        if (error instanceof MiniAppDistBuildError) throw error;
        console.warn(
          `[CloudPublish] dist build errored for ${appId} — publishing unbundled:`,
          (error as Error).message,
        );
      }

      try {
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
    }

    await this.publishAppFiles(appId);
    await writeCloudAppMetadataFile(this.paprDir, appId);

    const catalogIconResult = await prepareCatalogIconForPublish({
      icon: appMeta?.icon,
      appDir,
    });
    if (catalogIconResult.note) {
      console.log(`[CloudPublish] ${catalogIconResult.note}`);
    }

    let manifestPlatform: string[] | undefined;
    let manifestRequiresDesktop: boolean | undefined;
    if (lightSync) {
      const manifest = await reconcilePlatformCatalogManifest(this.paprDir, appId);
      manifestPlatform = manifest.platform;
      manifestRequiresDesktop = manifest.requiresDesktopForFullFunctionality;
      console.log(
        `[CloudPublish] Platform manifest for ${appId}: ${manifest.platform.join(", ")}` +
          (manifest.requiresDesktopForFullFunctionality
            ? " (desktop required)"
            : " (cloud-ready)"),
      );
    } else {
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
    }

    const catalogAutomation = await resolveCatalogAutomationForApp(appId);

    let data: PublishApiResponse | null = null;
    let lastError = "";
    for (const slug of slugCandidates) {
      try {
        data = await this.postPublishToMemory(appId, slug, {
          intent: "register",
          skipPlatformScan: lightSync,
          visibility: publishFields.visibility,
          linkPermission: publishFields.linkPermission,
          shareLinkEnabled: publishFields.shareLinkEnabled,
          requireSignIn: publishFields.requireSignIn,
          communityCatalogListed: publishFields.communityCatalogListed,
          codeAccess,
          credentialRequirements,
          catalogTitle: appMeta?.title,
          catalogDescription: appMeta?.description,
          catalogIcon: catalogIconResult.icon,
          catalogTags: appMeta?.tags,
          catalogHeadline: appMeta?.headline,
          ...sharedCoverCatalogFields(appId),
          catalogCategory: publishCategory(appId),
          catalogPlatform: manifestPlatform,
          catalogRequiresDesktop: manifestRequiresDesktop,
          catalogAutomation,
          shareAllowlist: memoryShareAllowlistBodyFromPrefs(prefs),
        });
        if (slug !== resolvedSlug) {
          console.log(
            `[CloudPublish] Used fallback slug ${slug} for ${appId} (resolved ${resolvedSlug})`,
          );
        }
        break;
      } catch (error) {
        lastError = (error as Error).message;
        const isNameCollision =
          lastError.includes("409") &&
          lastError.includes("already published in this namespace");
        if (!isNameCollision) {
          throw error;
        }
        if (slug === slugCandidates[slugCandidates.length - 1]) {
          throw new Error(
            `Couldn't find a free link for "${appMeta?.title ?? appId}" in this workspace ` +
              `(tried ${slugCandidates.join(", ")}). Rename the app and publish again.`,
          );
        }
        console.warn(
          `[CloudPublish] Slug ${slug} taken for ${appId}, retrying with next candidate`,
        );
      }
    }

    if (!data) {
      throw new Error(lastError || "Cloud publish failed");
    }
    const config = parsePublishConfig(appId, data, sharing);
    const writeSharingPrefs =
      hasExplicitSharing || !options?.preserveCloudSharing;
    const shareTokenFromPublish =
      sharingSettingsRequireShareToken(sharing) && config.shareToken
        ? config.shareToken
        : undefined;
    setAppPublishPrefs(
      appId,
      {
        ...(writeSharingPrefs
          ? {
              accessMode: config.accessMode,
              loginAccess: sharing.loginAccess,
              externalLink: sharing.externalLink,
              codeAccess,
              requireSignIn: publishFields.requireSignIn ?? false,
              liveLinkPermission: publishFields.linkPermission,
              shareToken: shareTokenFromPublish,
            }
          : shareTokenFromPublish
            ? { shareToken: shareTokenFromPublish }
            : {}),
        ...(perUserIsolation !== undefined ? { perUserIsolation } : {}),
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

    scheduleCloudAppHostAccessInvalidation(
      this.paprDir,
      appId,
      config,
      getAppPublishPrefs(appId, this.paprDir),
    );
    // Code may already be live (upload ran before this register call). If not,
    // flushAppNow records completion once the upload is web-ready.
    void import("./cloudSync/publishCompletion.js").then(({ markPublishComplete }) =>
      markPublishComplete(appId, this.paprDir),
    );
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
    const rows = await readAppFileRows(this.paprDir, appId);
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
      const rows = await readAppFileRows(this.paprDir, appId);
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
    const memory = await this.fetchMemoryPublishResponse(appId);

    await this.revokeAppFiles(appId);
    invalidatePublishStatusCache(appId);
    const response = await cloudApiFetch(
      `/v1/cloud/apps/publish/${encodeURIComponent(appId)}`,
      { method: "DELETE" },
    );
    if (response.status === 404) {
      if (memory) {
        scheduleCloudAppHostAccessInvalidation(
          this.paprDir,
          appId,
          {
            shareUrl: memory.shareUrl ?? null,
            slug: memory.slug ?? null,
          },
          {},
        );
      }
      return;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Cloud unpublish failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }
    invalidatePublishStatusCache(appId);

    if (memory) {
      scheduleCloudAppHostAccessInvalidation(
        this.paprDir,
        appId,
        {
          shareUrl: memory.shareUrl ?? null,
          slug: memory.slug ?? null,
        },
        {},
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

  async isAppReadyForCloudLink(
    appId: string,
    github: GitHubSyncItemsReport,
    turso: TursoSyncItemsReport | null,
  ): Promise<boolean> {
    const { isSyncV3FlagEnabled } = await import("./syncV3/syncV3Flags.js");
    if (isSyncV3FlagEnabled("SYNC_V3_WRITER_OPS")) {
      const { isAppWriterSyncReady } = await import("./syncV3/writerSyncStatus.js");
      const writerReady = await isAppWriterSyncReady(appId);
      if (!writerReady.ready) {
        return false;
      }
    } else {
      const appPath = `apps/${appId}`;
      const githubItem = github.apps.find((item) => item.relativePath === appPath);
      if (!githubItem || githubItem.status !== "synced") {
        return false;
      }
    }

    const tursoSources = turso?.sources.filter((s) => s.appId === appId) ?? [];
    if (tursoSources.length === 0) {
      return true;
    }
    return tursoSources.every((source) => source.status === "synced");
  }

  /**
   * When the memory publish record is gone but autoPublish is on, push git for
   * this app and reconcile sync state so auto-publish can run again.
   */
  private async tryRecoverAppSyncForPublish(
    appId: string,
    turso: TursoSyncItemsReport | null,
    github: GitHubSyncItemsReport,
  ): Promise<{ ready: boolean; github: GitHubSyncItemsReport }> {
    const { getCloudSyncService } = await import("./CloudSyncService.js");
    const sync = getCloudSyncService();
    if (!sync) {
      return { ready: false, github };
    }

    console.log(
      `[CloudPublish] Sync recovery for ${appId} (autoPublish on, memory publish disabled)`,
    );

    try {
      await sync.pushAppNow(appId);
    } catch (error) {
      console.warn(
        `[CloudPublish] Sync recovery push failed for ${appId}:`,
        (error as Error).message.slice(0, 120),
      );
      return { ready: false, github };
    }

    const refreshedGithub = sync.getGitHubSyncItemsReport();
    const ready = await this.isAppReadyForCloudLink(appId, refreshedGithub, turso);
    if (ready) {
      console.log(`[CloudPublish] Sync recovery succeeded for ${appId}`);
    } else {
      console.warn(
        `[CloudPublish] Sync recovery incomplete for ${appId} — git/turso not synced yet`,
      );
    }
    return { ready, github: refreshedGithub };
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
    return this.isAppReadyForCloudLink(appId, github, turso);
  }

  async tryAutoPublishSyncedApps(
    github: GitHubSyncItemsReport,
    turso: TursoSyncItemsReport | null,
    options?: {
      syncedAppIds?: readonly string[];
      /** flush = per-app post-hook only; catalog = background prefs recovery. */
      candidateScope?: AutoPublishCandidateScope;
    },
  ): Promise<void> {
    if (!isCloudAutoPublishGloballyEnabled()) {
      return;
    }
    if (!this.isWriteAllowed("auto-publish scan")) {
      return;
    }
    if (this.autoPublishInFlight) {
      return;
    }
    this.autoPublishInFlight = true;

    try {
      const catalogMeta = loadAppCatalogMeta(this.paprDir);
      const prefsFile = loadCloudPublishPrefs(this.paprDir);
      const candidateScope = options?.candidateScope ?? "flush";
      const candidateAppIds = mergeAutoPublishCandidateAppIds(
        [...catalogMeta.keys()],
        options?.syncedAppIds,
        prefsFile,
        candidateScope,
      );
      if (candidateAppIds.length === 0) {
        return;
      }
      let currentGithub = github;

      for (const appId of candidateAppIds) {
        const initialPrefs = getAppPublishPrefs(appId, this.paprDir);
        if (initialPrefs.autoPublish === false) {
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

        if (
          candidateScope === "flush" &&
          !(await this.isAppReadyForCloudLink(appId, currentGithub, turso)) &&
          needsPublishRecovery(memory, initialPrefs.autoPublish)
        ) {
          const recovered = await this.tryRecoverAppSyncForPublish(
            appId,
            turso,
            currentGithub,
          );
          currentGithub = recovered.github;
          if (!recovered.ready) {
            continue;
          }
        }

        if (!(await this.isAppReadyForCloudLink(appId, currentGithub, turso))) {
          continue;
        }
        if (!(await this.isAppVerifiedReadyForCloudLink(appId))) {
          console.warn(
            `[CloudPublish] Skipping auto-publish for ${appId}: post-push verify not passed`,
          );
          continue;
        }

        const needsInitialPublish = !memory?.enabled || !memory.shareUrl;

        if (candidateScope === "catalog") {
          if (!memory?.enabled) {
            continue;
          }
          try {
            if (!this.isWriteAllowed(`catalog-drift ${appId}`)) {
              continue;
            }
            if (isCloudCatalogLightSyncEnabled()) {
              await this.syncLiveAppArtifacts(appId);
            }
            const repaired = await this.syncCatalogIfDrift(appId);
            if (repaired) {
              console.log(
                `[CloudPublish] Background catalog drift repair for ${appId}`,
              );
            }
          } catch (error) {
            console.warn(
              `[CloudPublish] Background catalog drift failed for ${appId}:`,
              (error as Error).message.slice(0, 120),
            );
          }
          continue;
        }

        if (!needsInitialPublish) {
          continue;
        }

        try {
          if (!this.isWriteAllowed(`auto-publish ${appId}`)) {
            continue;
          }
          if (await copyIsOnTeamData(appId)) {
            continue;
          }
          const published = await this.publishApp(appId, { background: true });
          setAppPublishPrefs(
            appId,
            {
              lastAutoPublishAttemptAt: new Date().toISOString(),
              lastAutoPublishError: undefined,
            },
            this.paprDir,
          );
          const action = "Auto-published";
          console.log(
            `[CloudPublish] ${action} ${appId} → ${published.shareUrl ?? defaultAppsHost()}`,
          );
        } catch (error) {
          const message = (error as Error).message;
          if (message.includes("404") || message.includes("Not Found")) {
            console.warn(
              `[CloudPublish] Auto-publish skipped ${appId} (404) — continuing scan`,
            );
            continue;
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

/** Drop stale publish client bound to the previous workspace. */
export function resetCloudAppPublishServiceForWorkspaceSwitch(): void {
  instance = null;
}
