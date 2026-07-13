/**
 * Unified Community catalog — open-source bundles + Papr Cloud public apps.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type {
  CommunityCatalog,
  CommunityCatalogEntry,
} from "../../core/types/communityCatalog.js";
import { formatShareLink } from "../../core/utils/cloudShareLink.js";
import { communityCodeInstallable } from "../../core/utils/shareAudienceModel.js";
import { cloudApiFetch } from "../utils/cloudApiClient.js";
import {
  getBundleService,
  type CommunityRegistry,
} from "./BundleService.js";
import {
  resolveSharingSettings,
  sharingSettingsRequireShareToken,
} from "./cloudPublishMapping.js";
import { getAppPublishPrefs } from "./cloudPublishPrefs.js";
import { readAppRequirements } from "./cloudAppRequirements.js";
import {
  getCloudAppPublishService,
  type CloudPublishConfig,
} from "./CloudAppPublishService.js";

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
}

interface CloudCommunityApiResponse {
  apps?: CloudCommunityApiEntry[];
}

function loadLocalAppMeta(
  paprDir: string,
): Map<string, { title: string; description: string; icon?: string }> {
  const meta = new Map<string, { title: string; description: string; icon?: string }>();
  try {
    const raw = fs.readFileSync(path.join(paprDir, "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw) as
      | Array<{ id: string; title?: string; description?: string; icon?: string }>
      | Record<string, { id: string; title?: string; description?: string; icon?: string }>;
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    for (const app of list) {
      if (!app.id) continue;
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
    appId: entry.appId,
    namespaceId: entry.namespaceId,
    slug,
    liveUrl: entry.shareUrl ?? null,
    codeInstallable:
      entry.codeAccess === "install" || entry.codeInstallable === true,
    liveViewable: Boolean(entry.shareUrl),
    requirements: mapCatalogRequirements(entry.catalogRequirements),
  };
}

async function fetchRemoteCloudCatalog(): Promise<CloudCommunityApiEntry[]> {
  try {
    const response = await cloudApiFetch("/v1/cloud/apps/community");
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as CloudCommunityApiResponse;
    return Array.isArray(data.apps) ? data.apps : [];
  } catch {
    return [];
  }
}

async function buildLocalPublicCloudEntries(
  paprDir: string,
): Promise<CommunityCatalogEntry[]> {
  const meta = loadLocalAppMeta(paprDir);
  const publishService = getCloudAppPublishService();
  const entries: CommunityCatalogEntry[] = [];

  for (const [appId, appMeta] of meta) {
    const prefs = getAppPublishPrefs(appId, paprDir);
    const sharing = resolveSharingSettings(prefs);
    if (sharing.loginAccess !== "public") continue;

    let config: CloudPublishConfig;
    try {
      config = await publishService.getPublishConfig(appId);
    } catch {
      continue;
    }
    if (!config.enabled || !config.shareUrl) continue;

    const externalEnabled = sharingSettingsRequireShareToken(sharing);
    const liveUrl =
      formatShareLink(
        config.shareUrl,
        config.shareToken ?? prefs.shareToken ?? null,
        config.accessMode,
        externalEnabled,
      ) ?? config.shareUrl;

    const fileRequirements = readAppRequirements(paprDir, appId);

    entries.push({
      catalogId: `cloud:${appId}`,
      source: "cloud",
      name: appMeta.title,
      description: appMeta.description || "Public app on Papr Cloud",
      version: "cloud",
      author: "You",
      tags: ["cloud", "public"],
      icon: appMeta.icon,
      appId,
      namespaceId: undefined,
      slug: config.slug,
      liveUrl,
      codeInstallable: communityCodeInstallable(prefs.codeAccess ?? "off"),
      liveViewable: true,
      isOwned: true,
      requirements:
        fileRequirements.length > 0
          ? fileRequirements
          : prefs.credentialRequirements,
    });
  }

  return entries;
}

export class CommunityCatalogService {
  private readonly paprDir: string;

  constructor(paprDir?: string) {
    this.paprDir = paprDir ?? path.join(os.homedir(), "Papr");
  }

  async fetchCatalog(): Promise<CommunityCatalog> {
    const bundleService = getBundleService();
    const ossRegistry = await bundleService.fetchCommunityRegistry();
    const ossEntries = ossRegistry.bundles.map(opensourceEntry);

    const remoteCloud = await fetchRemoteCloudCatalog();
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

    const entries = [...cloudEntries, ...ossEntries];

    return {
      schemaVersion: "2.0.0",
      entries,
      sources: {
        opensource: ossEntries.length,
        cloud: cloudEntries.length,
      },
    };
  }
}

let catalogService: CommunityCatalogService | null = null;

export function getCommunityCatalogService(): CommunityCatalogService {
  if (!catalogService) {
    catalogService = new CommunityCatalogService();
  }
  return catalogService;
}
