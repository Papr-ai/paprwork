/**
 * Unified Community catalog — Papr Cloud public apps (+ workspace-scoped entries).
 */

import * as fs from "fs";
import * as path from "path";
import { getPaprRoot, getPaprAppsRoot } from "../../core/utils/paprRoot.js";

import {
  isLinkOnlyVisibility,
  isPublicCommunityVisibility,
  isTeamSharedVisibility,
  type CommunityCatalog,
  type CommunityCatalogEntry,
  type CommunityCatalogScope,
} from "../../core/types/communityCatalog.js";
import { formatShareLink } from "../../core/utils/cloudShareLink.js";
import {
  communityCodeInstallable,
  shouldListInCommunity,
  sharingToAudienceModel,
} from "../../core/utils/shareAudienceModel.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import { getPaprApiKey } from "../utils/keyResolver.js";
import {
  isActivePaprNamespace,
  paprApiKeyMatchesNamespace,
  parsePaprApiKeyScope,
} from "../../core/utils/paprApiKey.js";
import type { CloudSharingSettings } from "./cloudPublishMapping.js";
import {
  resolveSharingSettings,
  sharingSettingsRequireShareToken,
  visibilityToAccessMode,
} from "./cloudPublishMapping.js";
import { slugifyPublishTitle } from "./cloudPublishDrift.js";
import { getAppPublishPrefs, hasStoredAppPublishPrefs } from "./cloudPublishPrefs.js";
import { readAppRequirements } from "./cloudAppRequirements.js";
import { resolveCatalogEntryTags } from "../../core/utils/catalogTags.js";
import { readPlatformCatalogManifest } from "./syncV3/platformCatalogManifest.js";

interface CatalogPlatformMeta {
  platform: string[];
  requiresDesktopForFullFunctionality: boolean;
}

/** Prefer cached publish manifest — full compatibility scan is publish-time only. */
async function loadCatalogPlatformMeta(appId: string): Promise<CatalogPlatformMeta> {
  const manifest = await readPlatformCatalogManifest(
    path.join(getPaprAppsRoot(), appId),
  );
  if (manifest) {
    return {
      platform: manifest.platform,
      requiresDesktopForFullFunctionality: manifest.requiresDesktopForFullFunctionality,
    };
  }
  return {
    platform: ["macos", "windows", "linux"],
    requiresDesktopForFullFunctionality: false,
  };
}

interface CloudCommunityApiEntry {
  appId: string;
  namespaceId?: string;
  slug?: string | null;
  name?: string;
  description?: string;
  author?: string;
  icon?: string;
  tags?: string[];
  shareUrl?: string | null;
  shareToken?: string | null;
  shareLinkEnabled?: boolean;
  codeAccess?: "off" | "install";
  codeInstallable?: boolean;
  visibility?: string;
  publisherUserId?: string;
  catalogRequirements?: Array<{
    name: string;
    service: string;
    category?: string;
    description?: string;
    required?: boolean;
    credentialScope?: "owner" | "user";
    clientAccess?: "server" | "client";
    signupUrl?: string;
    docsUrl?: string;
  }>;
  catalogPlatform?: string[];
  catalogRequiresDesktop?: boolean;
}

interface CloudCommunityApiResponse {
  apps?: CloudCommunityApiEntry[];
}

import { isAppOwnedByCurrentUser } from "./appOwnership.js";
import { getPaprUserId } from "../utils/paprUserId.js";
import type { MiniApp } from "./AppService.js";
import {
  isAppAssignedToWorkspace,
  isBundledDefaultAppId,
  readActiveAppWorkspaceScope,
  type AppWorkspaceFields,
} from "../../core/utils/appWorkspaceScope.js";

function loadLocalAppMeta(
  paprDir: string,
): Map<
  string,
  AppWorkspaceFields & {
    title: string;
    description: string;
    icon?: string;
    tags?: string[];
  }
> {
  const meta = new Map<
    string,
    AppWorkspaceFields & {
      title: string;
      description: string;
      icon?: string;
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
          ownerUserId?: string;
          tags?: string[];
          organizationId?: string;
          namespaceId?: string;
        }>
      | Record<
          string,
          {
            id: string;
            title?: string;
            description?: string;
            icon?: string;
            ownerUserId?: string;
            tags?: string[];
            organizationId?: string;
            namespaceId?: string;
          }
        >;
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    for (const app of list) {
      if (!app.id) continue;
      const miniApp = app as MiniApp;
      if (!isAppOwnedByCurrentUser(miniApp)) continue;
      meta.set(app.id, {
        title: app.title?.trim() || app.id.slice(0, 8),
        description: app.description?.trim() || "",
        icon: app.icon,
        tags: app.tags,
        organizationId: app.organizationId,
        namespaceId: app.namespaceId,
      });
    }
  } catch {
    /* optional */
  }
  return meta;
}

function mapCatalogRequirements(
  items?: CloudCommunityApiEntry["catalogRequirements"],
): CommunityCatalogEntry["requirements"] {
  if (!items?.length) return undefined;
  return items.map((item) => ({
    name: item.name,
    service: item.service,
    category: (item.category ?? "other") as "other",
    description: item.description ?? "",
    required: item.required !== false,
    credentialScope: item.credentialScope === "owner" ? "owner" : "user",
    clientAccess: item.clientAccess === "client" ? "client" : "server",
    ...(item.signupUrl ? { signupUrl: item.signupUrl } : {}),
    ...(item.docsUrl ? { docsUrl: item.docsUrl } : {}),
  }));
}

/** Prefer external access link (?t=) over Papr-login app URL when link sharing is on. */
export function resolveCatalogLiveUrl(input: {
  shareUrl?: string | null;
  shareToken?: string | null;
  visibility?: string;
  shareLinkEnabled?: boolean;
  appId?: string;
  paprDir?: string;
}): string | null {
  const baseUrl = input.shareUrl;
  if (!baseUrl) return null;
  if (baseUrl.includes("?t=")) {
    return baseUrl;
  }

  let token = input.shareToken ?? null;
  let externalEnabled: boolean | undefined;
  if (input.shareLinkEnabled === true) {
    externalEnabled = true;
  } else if (input.shareLinkEnabled === false) {
    externalEnabled = false;
  } else if (
    input.visibility === "link_read" ||
    input.visibility === "link_read_write"
  ) {
    externalEnabled = true;
  }

  if (input.appId && input.paprDir) {
    const prefs = getAppPublishPrefs(input.appId, input.paprDir);
    const sharing = resolveSharingSettings(prefs);
    if (sharingSettingsRequireShareToken(sharing)) {
      externalEnabled = true;
      token = token ?? prefs.shareToken ?? null;
    }
  }

  return formatShareLink(
    baseUrl,
    token,
    visibilityToAccessMode(input.visibility),
    externalEnabled,
  );
}

/**
 * Resolve whether a catalog row allows fork/install (Customize).
 * Memory workspace rows often omit codeAccess/codeInstallable; papr web treats
 * omitted codeInstallable as installable (`!== false`). Desktop matches that,
 * with local synced publish prefs as a fallback when fields are missing.
 */
export function resolveCatalogCodeInstallable(
  entry: CloudCommunityApiEntry,
  paprDir?: string,
): boolean {
  if (entry.codeAccess === "off") {
    return false;
  }
  if (entry.codeAccess === "install") {
    return true;
  }
  if (typeof entry.codeInstallable === "boolean") {
    return entry.codeInstallable;
  }
  if (entry.appId && paprDir && hasStoredAppPublishPrefs(entry.appId, paprDir)) {
    const prefs = getAppPublishPrefs(entry.appId, paprDir);
    const localCode = prefs.codeAccess ?? "off";
    if (localCode === "off") {
      return false;
    }
    if (communityCodeInstallable(localCode)) {
      return true;
    }
  }
  return true;
}

function cloudEntryFromApi(
  entry: CloudCommunityApiEntry,
  paprDir?: string,
  localAppMeta?: Map<string, { tags?: string[] }>,
): CommunityCatalogEntry {
  const slug = entry.slug ?? null;
  const liveUrl = resolveCatalogLiveUrl({
    shareUrl: entry.shareUrl,
    shareToken: entry.shareToken,
    visibility: entry.visibility,
    shareLinkEnabled: entry.shareLinkEnabled,
    appId: entry.appId,
    paprDir,
  });
  return {
    catalogId: `cloud:${entry.appId}`,
    source: "cloud",
    name: entry.name ?? slug ?? entry.appId.slice(0, 8),
    description: entry.description ?? "",
    version: "cloud",
    author: entry.author ?? "Papr Cloud",
    tags: resolveCatalogEntryTags({
      tags: entry.tags,
      manifestTags: entry.appId ? localAppMeta?.get(entry.appId)?.tags : undefined,
    }),
    icon: entry.icon,
    platform: entry.catalogPlatform,
    requiresDesktopForFullFunctionality: entry.catalogRequiresDesktop,
    appId: entry.appId,
    namespaceId: entry.namespaceId,
    slug,
    liveUrl,
    codeInstallable: resolveCatalogCodeInstallable(entry, paprDir),
    liveViewable: Boolean(liveUrl ?? entry.shareUrl),
    requirements: mapCatalogRequirements(entry.catalogRequirements),
    visibility: entry.visibility,
    shareLinkEnabled: entry.shareLinkEnabled,
    publisherUserId: entry.publisherUserId,
  };
}

/**
 * True only for "Public in Community Apps" — not invite-link or link+sign-in shares.
 */
export function isCommunityCatalogListed(input: {
  visibility?: string;
  shareLinkEnabled?: boolean;
  liveUrl?: string | null;
  sharing?: Pick<CloudSharingSettings, "loginAccess" | "externalLink">;
  published?: boolean;
}): boolean {
  if (isLinkOnlyVisibility(input.visibility)) {
    return false;
  }
  if (input.shareLinkEnabled === true) {
    return false;
  }
  if (input.liveUrl?.includes("?t=")) {
    return false;
  }
  if (input.sharing) {
    const model = sharingToAudienceModel(
      input.sharing.loginAccess,
      input.sharing.externalLink,
    );
    return shouldListInCommunity(model.audience, input.published ?? true);
  }
  return isPublicCommunityVisibility(input.visibility);
}

function buildCatalog(
  scope: CommunityCatalogScope,
  entries: CommunityCatalogEntry[],
  extras?: Pick<CommunityCatalog, "fallbackUsed" | "namespaceId">,
): CommunityCatalog {
  const cloud = entries.filter((entry) => entry.source === "cloud").length;
  const opensource = entries.filter((entry) => entry.source === "opensource").length;
  return {
    schemaVersion: "2.0.0",
    scope,
    entries,
    sources: { opensource, cloud },
    ...extras,
  };
}

interface RemoteCloudCatalogFetchOptions {
  /** Global community listing — do not scope by acting user. */
  globalCommunity?: boolean;
}

async function fetchRemoteCloudCatalog(
  path: string,
  options?: RemoteCloudCatalogFetchOptions,
): Promise<CloudCommunityApiEntry[]> {
  try {
    const response = await cloudApiFetch(path, {
      skipActingUser: options?.globalCommunity === true,
    });
    if (!response.ok) {
      if (response.status !== 404) {
        console.warn(
          `[CommunityCatalog] ${response.status} from memory server GET ${path}`,
        );
      }
      return [];
    }
    const data = (await response.json()) as CloudCommunityApiResponse;
    return Array.isArray(data.apps) ? data.apps : [];
  } catch (error) {
    console.warn(
      `[CommunityCatalog] Failed memory server GET ${path}:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

function teamCatalogQuery(namespaceId: string): string {
  return `?namespaceId=${encodeURIComponent(namespaceId)}`;
}

async function assertPaprApiKeyForNamespace(namespaceId: string): Promise<void> {
  const apiKey = await getPaprApiKey();
  if (!apiKey) {
    throw new Error("PAPR_API_KEY not configured. Login with Papr first.");
  }

  // Main process resolves keys from PAPR_API_KEY__{namespaceId} for the active workspace.
  // Legacy keys may omit org/namespace segments — trust the vault slot binding.
  if (isActivePaprNamespace(namespaceId)) {
    return;
  }

  const keyScope = parsePaprApiKeyScope(apiKey);
  const orgId =
    process.env.PAPR_ORG_ID?.trim() ?? keyScope?.organizationId ?? "";
  if (!orgId || paprApiKeyMatchesNamespace(apiKey, orgId, namespaceId)) {
    return;
  }

  throw new Error(
    `PAPR API key is for namespace "${keyScope?.namespaceId ?? "unknown"}" but Team Apps needs "${namespaceId}". ` +
      "Open Settings → Papr and re-select your workspace to refresh credentials.",
  );
}

/** Team routes are scoped by query param — entries may omit namespaceId. */
function teamEntryFromApi(
  item: CloudCommunityApiEntry,
  namespaceId: string,
  paprDir?: string,
  localAppMeta?: Map<string, { tags?: string[] }>,
): CommunityCatalogEntry {
  return cloudEntryFromApi(
    {
      ...item,
      namespaceId: item.namespaceId ?? namespaceId,
      visibility: item.visibility ?? "team",
    },
    paprDir,
    localAppMeta,
  );
}

function filterNamespaceCloudEntries(
  entries: CommunityCatalogEntry[],
  namespaceId: string,
): CommunityCatalogEntry[] {
  return entries.filter(
    (entry) => entry.source === "cloud" && entry.namespaceId === namespaceId,
  );
}

const NAMESPACE_CATALOG_CACHE_TTL_MS = 5 * 60_000;
const GLOBAL_CATALOG_CACHE_TTL_MS = 5 * 60_000;
const namespaceCatalogCache = new Map<
  string,
  { fetchedAt: number; catalog: CommunityCatalog }
>();
let globalCatalogCache: { fetchedAt: number; catalog: CommunityCatalog } | null =
  null;

export function clearNamespaceCommunityCatalogCache(): void {
  namespaceCatalogCache.clear();
  globalCatalogCache = null;
}

/** Merge memory-server workspace rows with local-only team publishes. */
export function mergeNamespaceWorkspaceCatalog(input: {
  workspaceRemote: CloudCommunityApiEntry[];
  localTeamEntries: CommunityCatalogEntry[];
  paprDir: string;
  namespaceId: string;
  ownedAppIds: Set<string>;
}): CommunityCatalogEntry[] {
  const localAppMeta = loadLocalAppMeta(input.paprDir);
  const remoteEntries = filterPublicCommunityEntries(
    input.workspaceRemote.map((item) =>
      cloudEntryFromApi(item, input.paprDir, localAppMeta),
    ),
    input.paprDir,
    input.ownedAppIds,
    { allowTeam: true },
  );
  const remoteAppIds = new Set(
    remoteEntries
      .map((entry) => entry.appId)
      .filter((appId): appId is string => Boolean(appId)),
  );
  const localOnly = input.localTeamEntries.filter(
    (entry) => entry.appId && !remoteAppIds.has(entry.appId),
  );
  return markOwnedEntries(
    dedupeCloudEntries([...remoteEntries, ...localOnly], input.paprDir),
    input.ownedAppIds,
  );
}

function isE2eTestCatalogSlug(slug: string | null | undefined): boolean {
  const trimmed = slug?.trim();
  return Boolean(trimmed && /^e2e-/i.test(trimmed));
}

function scoreCatalogEntryForDedupe(
  entry: CommunityCatalogEntry,
  paprDir?: string,
): number {
  let score = 0;
  const slug = entry.slug?.trim() ?? "";
  const name = entry.name?.trim() ?? "";

  if (name && name !== slug) {
    score += 120;
  } else if (name) {
    score += 40;
  }

  if (slug && !isE2eTestCatalogSlug(slug)) {
    score += 50;
  }
  if (isE2eTestCatalogSlug(slug)) {
    score -= 500;
  }

  if (entry.codeInstallable) {
    score += 30;
  }

  const currentUserId = getPaprUserId()?.trim();
  if (currentUserId && entry.publisherUserId?.trim() === currentUserId) {
    score += 100;
  }

  if (paprDir && entry.appId) {
    const prefs = getAppPublishPrefs(entry.appId, paprDir);
    if (prefs.accessMode === "team" || prefs.loginAccess === "team") {
      score += 10;
    }
    if (prefs.codeAccess === "install" && entry.codeInstallable) {
      score += 20;
    }
  }

  return score;
}

function pickPreferredCatalogEntry(
  entries: CommunityCatalogEntry[],
  paprDir?: string,
): CommunityCatalogEntry {
  if (entries.length <= 1) {
    return entries[0];
  }
  return entries.reduce((best, candidate) =>
    scoreCatalogEntryForDedupe(candidate, paprDir) >
    scoreCatalogEntryForDedupe(best, paprDir)
      ? candidate
      : best,
  );
}

function dedupeCloudEntries(
  entries: CommunityCatalogEntry[],
  paprDir?: string,
): CommunityCatalogEntry[] {
  const withoutAppId: CommunityCatalogEntry[] = [];
  const byAppId = new Map<string, CommunityCatalogEntry[]>();

  for (const entry of entries) {
    const appId = entry.appId?.trim();
    if (!appId) {
      withoutAppId.push(entry);
      continue;
    }
    const group = byAppId.get(appId) ?? [];
    group.push(entry);
    byAppId.set(appId, group);
  }

  const merged: CommunityCatalogEntry[] = [...withoutAppId];
  for (const group of byAppId.values()) {
    merged.push(pickPreferredCatalogEntry(group, paprDir));
  }
  return merged;
}

function markOwnedEntries(
  entries: CommunityCatalogEntry[],
  _ownedAppIds: Set<string>,
): CommunityCatalogEntry[] {
  const currentUserId = getPaprUserId()?.trim();
  return entries.map((entry) => {
    if (entry.isOwned === true) {
      return entry;
    }

    const publisherUserId = entry.publisherUserId?.trim();
    if (publisherUserId && currentUserId) {
      return publisherUserId === currentUserId
        ? { ...entry, isOwned: true }
        : { ...entry, isOwned: false };
    }

    return { ...entry, isOwned: false };
  });
}

/**
 * Workspace / community catalog inclusion rules.
 * When allowTeam is set, team-shared apps (including ones you published) belong in Team Apps.
 */
function shouldIncludeInPublicCommunity(
  entry: CommunityCatalogEntry,
  paprDir: string,
  ownedAppIds: Set<string>,
  options?: { allowTeam?: boolean },
): boolean {
  if (entry.source !== "cloud") {
    return true;
  }

  if (isTeamSharedVisibility(entry.visibility)) {
    return options?.allowTeam === true;
  }

  if (entry.appId && ownedAppIds.has(entry.appId)) {
    const prefs = getAppPublishPrefs(entry.appId, paprDir);
    const sharing = resolveSharingSettings({
      ...prefs,
      shareToken: prefs.shareToken,
    });
    if (options?.allowTeam && sharing.loginAccess === "team") {
      return true;
    }
    return isCommunityCatalogListed({
      visibility: entry.visibility,
      shareLinkEnabled: entry.shareLinkEnabled,
      liveUrl: entry.liveUrl,
      sharing,
    });
  }

  return isCommunityCatalogListed({
    visibility: entry.visibility,
    shareLinkEnabled: entry.shareLinkEnabled,
    liveUrl: entry.liveUrl,
  });
}

function filterPublicCommunityEntries(
  entries: CommunityCatalogEntry[],
  paprDir: string,
  ownedAppIds: Set<string>,
  options?: { allowTeam?: boolean },
): CommunityCatalogEntry[] {
  return entries.filter((entry) =>
    shouldIncludeInPublicCommunity(entry, paprDir, ownedAppIds, options),
  );
}

/** Global Community tab — installable / forkable listings only (no preview-only). */
export function isCommunityBrowseListing(
  entry: CommunityCatalogEntry,
): boolean {
  if (entry.source === "opensource") {
    return true;
  }
  return entry.codeInstallable === true;
}

function filterBrowseableCommunityEntries(
  entries: CommunityCatalogEntry[],
): CommunityCatalogEntry[] {
  return entries.filter(isCommunityBrowseListing);
}

function defaultCloudAppsHost(): string {
  return (
    process.env.PAPR_CLOUD_APPS_HOST?.replace(/\/$/, "") ??
    "https://apps.papr.ai"
  );
}

/**
 * Build team/public catalog entries from local prefs only — no per-app memory GET.
 * Used by Team Apps tab; full publish config is loaded on demand in share settings.
 */
export function buildLocalCatalogConfigFromPrefs(
  appId: string,
  paprDir: string,
  appMeta: { title: string },
  namespaceId?: string,
): { enabled: boolean; shareUrl: string | null; slug: string | null } {
  const prefs = getAppPublishPrefs(appId, paprDir);
  const sharing = resolveSharingSettings(prefs);
  const slug = slugifyPublishTitle(appMeta.title ?? appId.slice(0, 8));
  const ns =
    namespaceId?.trim() ||
    process.env.PAPR_NAMESPACE_ID?.trim() ||
    "";

  const publishedLocally =
    prefs.autoPublish !== false &&
    !prefs.lastAutoPublishError &&
    sharing.loginAccess !== "private";

  if (!publishedLocally && !prefs.shareToken) {
    return { enabled: false, shareUrl: null, slug };
  }

  if (!ns) {
    return { enabled: false, shareUrl: null, slug };
  }

  const shareUrlBase = `${defaultCloudAppsHost()}/${ns}/${slug}/`;
  const externalEnabled = sharingSettingsRequireShareToken(sharing);
  const shareUrl = formatShareLink(
    shareUrlBase,
    prefs.shareToken ?? null,
    prefs.accessMode,
    externalEnabled,
  );

  return {
    enabled: Boolean(shareUrl),
    shareUrl,
    slug,
  };
}

async function buildLocalCloudEntriesForSharing(
  paprDir: string,
  options: {
    loginAccess: "public" | "team";
    namespaceId?: string;
  },
): Promise<CommunityCatalogEntry[]> {
  const meta = loadLocalAppMeta(paprDir);
  const entries: CommunityCatalogEntry[] = [];
  const catalogScope =
    options.namespaceId?.trim() && process.env.PAPR_ORG_ID?.trim()
      ? {
          organizationId: process.env.PAPR_ORG_ID.trim(),
          namespaceId: options.namespaceId.trim(),
        }
      : readActiveAppWorkspaceScope();

  for (const [appId, appMeta] of meta) {
    if (
      catalogScope &&
      !isBundledDefaultAppId(appId) &&
      !isAppAssignedToWorkspace(appMeta, catalogScope)
    ) {
      continue;
    }

    const prefs = getAppPublishPrefs(appId, paprDir);
    const sharing = resolveSharingSettings(prefs);
    if (sharing.loginAccess !== options.loginAccess) continue;
    if (
      options.loginAccess === "public" &&
      !isCommunityCatalogListed({ sharing })
    ) {
      continue;
    }

    const config = buildLocalCatalogConfigFromPrefs(
      appId,
      paprDir,
      appMeta,
      options.namespaceId,
    );
    if (!config.enabled || !config.shareUrl) continue;

    const fileRequirements = readAppRequirements(paprDir, appId);
    const teamShared = options.loginAccess === "team";
    const platformMeta = await loadCatalogPlatformMeta(appId);

    entries.push({
      catalogId: `cloud:${appId}`,
      source: "cloud",
      name: appMeta.title,
      description:
        appMeta.description ||
        (teamShared
          ? "Team-shared app on Papr Cloud"
          : "Public app on Papr Cloud"),
      version: "cloud",
      author: "You",
      tags: resolveCatalogEntryTags({ manifestTags: appMeta.tags }),
      icon: appMeta.icon,
      platform: platformMeta.platform,
      requiresDesktopForFullFunctionality:
        platformMeta.requiresDesktopForFullFunctionality,
      appId,
      namespaceId: options.namespaceId,
      slug: config.slug,
      liveUrl: config.shareUrl,
      codeInstallable: communityCodeInstallable(prefs.codeAccess ?? "off"),
      liveViewable: true,
      isOwned: true,
      visibility: teamShared ? "team" : "public_read",
      shareLinkEnabled: sharing.externalLink !== "off",
      requirements:
        fileRequirements.length > 0
          ? fileRequirements
          : prefs.credentialRequirements,
    });
  }

  return entries;
}

async function buildLocalPublicCloudEntries(
  paprDir: string,
): Promise<CommunityCatalogEntry[]> {
  return buildLocalCloudEntriesForSharing(paprDir, { loginAccess: "public" });
}

async function buildLocalTeamSharedCloudEntries(
  paprDir: string,
  namespaceId: string,
): Promise<CommunityCatalogEntry[]> {
  return buildLocalCloudEntriesForSharing(paprDir, {
    loginAccess: "team",
    namespaceId,
  });
}

export class CommunityCatalogService {
  private readonly paprDirOverride?: string;

  constructor(paprDir?: string) {
    this.paprDirOverride = paprDir;
  }

  private get paprDir(): string {
    return this.paprDirOverride ?? getPaprRoot();
  }

  private ownedLocalAppIds(): Set<string> {
    return new Set(loadLocalAppMeta(this.paprDir).keys());
  }

  async fetchCatalog(): Promise<CommunityCatalog> {
    const cached = globalCatalogCache;
    if (
      cached &&
      Date.now() - cached.fetchedAt < GLOBAL_CATALOG_CACHE_TTL_MS
    ) {
      return { ...cached.catalog, fromCache: true };
    }

    const ownedAppIds = this.ownedLocalAppIds();
    const localAppMeta = loadLocalAppMeta(this.paprDir);

    const remoteCloud = await fetchRemoteCloudCatalog("/v1/cloud/apps/community", {
      globalCommunity: true,
    });
    let cloudEntries = remoteCloud.map((item) =>
      cloudEntryFromApi(item, this.paprDir, localAppMeta),
    );

    if (cloudEntries.length === 0) {
      console.warn(
        "[CommunityCatalog] Global community API returned no apps — using local publish prefs fallback",
      );
      cloudEntries = await buildLocalPublicCloudEntries(this.paprDir);
    } else {
      const seen = new Set(cloudEntries.map((entry) => entry.appId));
      const localEntries = await buildLocalPublicCloudEntries(this.paprDir);
      for (const entry of localEntries) {
        if (entry.appId && !seen.has(entry.appId)) {
          cloudEntries.push(entry);
        }
      }
    }

    cloudEntries = filterBrowseableCommunityEntries(
      filterPublicCommunityEntries(
        cloudEntries,
        this.paprDir,
        ownedAppIds,
      ),
    );

    // Community Apps tab is cloud-publish only. OSS paprwork-community-apps is deprecated.
    const catalog = buildCatalog("global", cloudEntries);
    globalCatalogCache = { fetchedAt: Date.now(), catalog };
    return catalog;
  }

  private async fetchTeamSharedEntries(
    namespaceId: string,
  ): Promise<CommunityCatalogEntry[]> {
    const query = teamCatalogQuery(namespaceId);
    const paths = [
      `/v1/cloud/apps/shared-with-me${query}`,
      `/v1/cloud/apps/team${query}`,
    ];
    const responses = await Promise.all(
      paths.map((cloudPath) => fetchRemoteCloudCatalog(cloudPath)),
    );

    const merged: CommunityCatalogEntry[] = [];
    const seen = new Set<string>();
    const localAppMeta = loadLocalAppMeta(this.paprDir);

    for (const remote of responses) {
      for (const item of remote) {
        const entry = teamEntryFromApi(
          item,
          namespaceId,
          this.paprDir,
          localAppMeta,
        );
        if (entry.namespaceId && entry.namespaceId !== namespaceId) continue;
        if (!isTeamSharedVisibility(entry.visibility)) continue;
        const key = entry.appId ?? entry.catalogId;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(entry);
      }
    }

    return merged;
  }

  /**
   * Fallback when `/workspace` is empty — still avoids global OSS registry fetch.
   */
  private async fetchNamespaceCommunityFallback(
    namespaceId: string,
    ownedAppIds: Set<string>,
  ): Promise<CommunityCatalog> {
    const encodedNamespaceId = encodeURIComponent(namespaceId);
    const communityPath = `/v1/cloud/apps/namespace/${encodedNamespaceId}/community`;

    const localAppMeta = loadLocalAppMeta(this.paprDir);

    const [dedicatedCommunity, teamRemote, localTeamEntries] = await Promise.all([
      fetchRemoteCloudCatalog(communityPath),
      this.fetchTeamSharedEntries(namespaceId),
      buildLocalTeamSharedCloudEntries(this.paprDir, namespaceId),
    ]);

    let publicEntries: CommunityCatalogEntry[] = [];
    let fallbackUsed = false;

    if (dedicatedCommunity.length > 0) {
      publicEntries = filterPublicCommunityEntries(
        dedicatedCommunity.map((item) =>
          cloudEntryFromApi(item, this.paprDir, localAppMeta),
        ),
        this.paprDir,
        ownedAppIds,
        { allowTeam: true },
      );
    } else {
      const globalCloud = await fetchRemoteCloudCatalog("/v1/cloud/apps/community", {
        globalCommunity: true,
      });
      publicEntries = filterPublicCommunityEntries(
        filterNamespaceCloudEntries(
          globalCloud.map((item) =>
            cloudEntryFromApi(item, this.paprDir, localAppMeta),
          ),
          namespaceId,
        ),
        this.paprDir,
        ownedAppIds,
        { allowTeam: true },
      );
      fallbackUsed = publicEntries.length > 0;
    }

    const teamEntries = dedupeCloudEntries(
      [...teamRemote, ...localTeamEntries],
      this.paprDir,
    );
    const entries = markOwnedEntries(
      dedupeCloudEntries([...teamEntries, ...publicEntries], this.paprDir),
      ownedAppIds,
    );

    return buildCatalog("namespace", entries, {
      namespaceId,
      fallbackUsed: fallbackUsed && teamEntries.length === 0,
    });
  }

  /**
   * Workspace catalog: team-shared + public cloud apps in the active namespace.
   * Fast path: one memory-server GET (`/v1/cloud/apps/namespace/{id}/workspace`).
   * That route is the indexed catalog table — no per-app lookups on desktop.
   */
  async fetchNamespaceCommunity(
    namespaceId: string,
  ): Promise<CommunityCatalog> {
    const cached = namespaceCatalogCache.get(namespaceId);
    if (
      cached &&
      Date.now() - cached.fetchedAt < NAMESPACE_CATALOG_CACHE_TTL_MS
    ) {
      return { ...cached.catalog, fromCache: true };
    }

    await assertPaprApiKeyForNamespace(namespaceId);
    const ownedAppIds = this.ownedLocalAppIds();
    const encodedNamespaceId = encodeURIComponent(namespaceId);
    const workspacePath = `/v1/cloud/apps/namespace/${encodedNamespaceId}/workspace`;

    const [workspaceRemote, localTeamEntries] = await Promise.all([
      fetchRemoteCloudCatalog(workspacePath),
      buildLocalTeamSharedCloudEntries(this.paprDir, namespaceId),
    ]);

    let catalog: CommunityCatalog;
    if (workspaceRemote.length > 0) {
      const entries = mergeNamespaceWorkspaceCatalog({
        workspaceRemote,
        localTeamEntries,
        paprDir: this.paprDir,
        namespaceId,
        ownedAppIds,
      });
      catalog = buildCatalog("namespace", entries, { namespaceId });
    } else {
      catalog = await this.fetchNamespaceCommunityFallback(
        namespaceId,
        ownedAppIds,
      );
    }

    namespaceCatalogCache.set(namespaceId, {
      fetchedAt: Date.now(),
      catalog,
    });
    return catalog;
  }

  async fetchScopedCatalog(input: {
    scope: CommunityCatalogScope;
    namespaceId?: string;
  }): Promise<CommunityCatalog> {
    if (input.scope === "namespace" && input.namespaceId) {
      return this.fetchNamespaceCommunity(input.namespaceId);
    }
    return this.fetchCatalog();
  }
}

let catalogService: CommunityCatalogService | null = null;

export function getCommunityCatalogService(): CommunityCatalogService {
  if (!catalogService) {
    catalogService = new CommunityCatalogService();
  }
  return catalogService;
}

export function resetCommunityCatalogServiceForWorkspaceSwitch(): void {
  catalogService = null;
  clearNamespaceCommunityCatalogCache();
}

/** @internal Exported for unit tests */
export { shouldIncludeInPublicCommunity, teamCatalogQuery, teamEntryFromApi };
