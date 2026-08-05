/**
 * Unified Community catalog — open-source bundles + Papr Cloud public apps.
 */

import * as fs from "fs";
import { getPaprRoot } from "../../core/utils/paprRoot.js";
import * as path from "path";

import {
  isPublicCommunityVisibility,
  isTeamSharedVisibility,
  type CommunityCatalog,
  type CommunityCatalogEntry,
  type CommunityCatalogScope,
} from "../../core/types/communityCatalog.js";
import { formatShareLink } from "../../core/utils/cloudShareLink.js";
import { communityCodeInstallable } from "../../core/utils/shareAudienceModel.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import { getPaprApiKey } from "../utils/keyResolver.js";
import {
  isActivePaprNamespace,
  paprApiKeyMatchesNamespace,
  parsePaprApiKeyScope,
} from "../../core/utils/paprApiKey.js";
import {
  getBundleService,
  type CommunityRegistry,
} from "./BundleService.js";
import {
  resolveSharingSettings,
  sharingSettingsRequireShareToken,
} from "./cloudPublishMapping.js";
import { slugifyPublishTitle } from "./cloudPublishDrift.js";
import { getAppPublishPrefs } from "./cloudPublishPrefs.js";
import { readAppRequirements } from "./cloudAppRequirements.js";

async function loadCommunityPlatformForApp(appId: string): Promise<{
  platform: string[];
  requiresDesktopForFullFunctionality: boolean;
}> {
  const { detectCommunityPlatformForApp } = await import(
    "./cloudAppCompatibility.js"
  );
  const report = await detectCommunityPlatformForApp(appId);
  return {
    platform: report.platform,
    requiresDesktopForFullFunctionality: report.requiresDesktopForFullFunctionality,
  };
}

async function enrichOwnedCloudPlatformEntries(
  entries: CommunityCatalogEntry[],
  ownedAppIds: Set<string>,
): Promise<CommunityCatalogEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      if (
        entry.source !== "cloud" ||
        !entry.appId ||
        !ownedAppIds.has(entry.appId)
      ) {
        return entry;
      }
      if (
        entry.platform?.length &&
        entry.requiresDesktopForFullFunctionality !== undefined
      ) {
        return entry;
      }
      const platformMeta = await loadCommunityPlatformForApp(entry.appId);
      return { ...entry, ...platformMeta };
    }),
  );
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
import type { MiniApp } from "./AppService.js";

function loadLocalAppMeta(
  paprDir: string,
): Map<string, { title: string; description: string; icon?: string }> {
  const meta = new Map<string, { title: string; description: string; icon?: string }>();
  try {
    const raw = fs.readFileSync(path.join(paprDir, "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw) as
      | Array<{ id: string; title?: string; description?: string; icon?: string; ownerUserId?: string }>
      | Record<string, { id: string; title?: string; description?: string; icon?: string; ownerUserId?: string }>;
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    for (const app of list) {
      if (!app.id) continue;
      const miniApp = app as MiniApp;
      if (!isAppOwnedByCurrentUser(miniApp)) continue;
      meta.set(app.id, {
        title: app.title?.trim() || app.id.slice(0, 8),
        description: app.description?.trim() || "",
        icon: app.icon,
      });
    }
  } catch {
    /* optional */
  }
  return meta;
}

function opensourceEntry(
  bundle: CommunityRegistry["bundles"][number],
): CommunityCatalogEntry {
  return {
    catalogId: `oss:${bundle.bundleId}`,
    source: "opensource",
    name: bundle.name,
    description: bundle.description,
    version: bundle.version,
    author: bundle.author,
    tags: bundle.tags,
    icon: bundle.icon,
    platform: bundle.platform,
    requirements: bundle.requirements,
    minPaprworkVersion: bundle.minPaprworkVersion,
    bundleId: bundle.bundleId,
    path: bundle.path,
    codeInstallable: true,
    liveViewable: false,
  };
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

function cloudEntryFromApi(entry: CloudCommunityApiEntry): CommunityCatalogEntry {
  const slug = entry.slug ?? null;
  return {
    catalogId: `cloud:${entry.appId}`,
    source: "cloud",
    name: entry.name ?? slug ?? entry.appId.slice(0, 8),
    description: entry.description ?? "",
    version: "cloud",
    author: entry.author ?? "Papr Cloud",
    tags: entry.tags ?? ["cloud"],
    icon: entry.icon,
    platform: entry.catalogPlatform,
    requiresDesktopForFullFunctionality: entry.catalogRequiresDesktop,
    appId: entry.appId,
    namespaceId: entry.namespaceId,
    slug,
    liveUrl: entry.shareUrl ?? null,
    codeInstallable:
      entry.codeAccess === "install" || entry.codeInstallable === true,
    liveViewable: Boolean(entry.shareUrl),
    requirements: mapCatalogRequirements(entry.catalogRequirements),
    visibility: entry.visibility,
    publisherUserId: entry.publisherUserId,
  };
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

async function fetchRemoteCloudCatalog(path: string): Promise<CloudCommunityApiEntry[]> {
  try {
    const response = await cloudApiFetch(path);
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
): CommunityCatalogEntry {
  return cloudEntryFromApi({
    ...item,
    namespaceId: item.namespaceId ?? namespaceId,
    visibility: item.visibility ?? "team",
  });
}

function filterNamespaceCloudEntries(
  entries: CommunityCatalogEntry[],
  namespaceId: string,
): CommunityCatalogEntry[] {
  return entries.filter(
    (entry) => entry.source === "cloud" && entry.namespaceId === namespaceId,
  );
}

const NAMESPACE_CATALOG_CACHE_TTL_MS = 30_000;
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
  const remoteEntries = filterPublicCommunityEntries(
    input.workspaceRemote.map(cloudEntryFromApi),
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
    dedupeCloudEntries([...remoteEntries, ...localOnly]),
    input.ownedAppIds,
  );
}

function dedupeCloudEntries(entries: CommunityCatalogEntry[]): CommunityCatalogEntry[] {
  const seen = new Set<string>();
  const merged: CommunityCatalogEntry[] = [];
  for (const entry of entries) {
    const key = entry.appId ?? entry.catalogId;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function markOwnedEntries(
  entries: CommunityCatalogEntry[],
  ownedAppIds: Set<string>,
): CommunityCatalogEntry[] {
  return entries.map((entry) =>
    entry.appId && ownedAppIds.has(entry.appId) ? { ...entry, isOwned: true } : entry,
  );
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
    const sharing = resolveSharingSettings(getAppPublishPrefs(entry.appId, paprDir));
    if (options?.allowTeam && sharing.loginAccess === "team") {
      return true;
    }
    return sharing.loginAccess === "public";
  }

  return isPublicCommunityVisibility(entry.visibility);
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

  for (const [appId, appMeta] of meta) {
    const prefs = getAppPublishPrefs(appId, paprDir);
    const sharing = resolveSharingSettings(prefs);
    if (sharing.loginAccess !== options.loginAccess) continue;

    const config = buildLocalCatalogConfigFromPrefs(
      appId,
      paprDir,
      appMeta,
      options.namespaceId,
    );
    if (!config.enabled || !config.shareUrl) continue;

    const fileRequirements = readAppRequirements(paprDir, appId);
    const teamShared = options.loginAccess === "team";
    const platformMeta = await loadCommunityPlatformForApp(appId);

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
      tags: teamShared ? ["cloud", "team"] : ["cloud", "public"],
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

    const bundleService = getBundleService();
    const ossRegistry = await bundleService.fetchCommunityRegistry();
    const ossEntries = ossRegistry.bundles.map(opensourceEntry);
    const ownedAppIds = this.ownedLocalAppIds();

    const remoteCloud = await fetchRemoteCloudCatalog("/v1/cloud/apps/community");
    let cloudEntries = remoteCloud.map(cloudEntryFromApi);

    if (cloudEntries.length === 0) {
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

    cloudEntries = filterPublicCommunityEntries(
      cloudEntries,
      this.paprDir,
      ownedAppIds,
    );
    cloudEntries = await enrichOwnedCloudPlatformEntries(
      cloudEntries,
      ownedAppIds,
    );

    const catalog = buildCatalog("global", [...cloudEntries, ...ossEntries]);
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

    for (const remote of responses) {
      for (const item of remote) {
        const entry = teamEntryFromApi(item, namespaceId);
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

    const [dedicatedCommunity, teamRemote, localTeamEntries] = await Promise.all([
      fetchRemoteCloudCatalog(communityPath),
      this.fetchTeamSharedEntries(namespaceId),
      buildLocalTeamSharedCloudEntries(this.paprDir, namespaceId),
    ]);

    let publicEntries: CommunityCatalogEntry[] = [];
    let fallbackUsed = false;

    if (dedicatedCommunity.length > 0) {
      publicEntries = filterPublicCommunityEntries(
        dedicatedCommunity.map(cloudEntryFromApi),
        this.paprDir,
        ownedAppIds,
        { allowTeam: true },
      );
    } else {
      const globalCloud = await fetchRemoteCloudCatalog("/v1/cloud/apps/community");
      publicEntries = filterPublicCommunityEntries(
        filterNamespaceCloudEntries(
          globalCloud.map(cloudEntryFromApi),
          namespaceId,
        ),
        this.paprDir,
        ownedAppIds,
        { allowTeam: true },
      );
      fallbackUsed = publicEntries.length > 0;
    }

    const teamEntries = dedupeCloudEntries([...teamRemote, ...localTeamEntries]);
    const entries = await enrichOwnedCloudPlatformEntries(
      markOwnedEntries(
        dedupeCloudEntries([...teamEntries, ...publicEntries]),
        ownedAppIds,
      ),
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

    const workspaceRemote = await fetchRemoteCloudCatalog(workspacePath);

    let catalog: CommunityCatalog;
    if (workspaceRemote.length > 0) {
      const localTeamEntries = await buildLocalTeamSharedCloudEntries(
        this.paprDir,
        namespaceId,
      );
      const entries = await enrichOwnedCloudPlatformEntries(
        mergeNamespaceWorkspaceCatalog({
          workspaceRemote,
          localTeamEntries,
          paprDir: this.paprDir,
          namespaceId,
          ownedAppIds,
        }),
        ownedAppIds,
      );
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
