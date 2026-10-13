/**
 * Unified Community Apps catalog — open-source bundles + Papr Cloud public apps.
 */

import type { CatalogAutomation } from "./catalogAutomation.js";
import type { RequirementItem } from "./bundles.js";

export type CommunityCatalogSource = "opensource" | "cloud";

/** Which Apps tab catalog scope to load. */
export type CommunityCatalogScope = "global" | "namespace";

export function isTeamSharedVisibility(visibility: string | undefined): boolean {
  if (!visibility) return false;
  return visibility === "team" || visibility.startsWith("team_");
}

/** Unlisted invite-link modes — never in Community Apps catalog. */
export function isLinkOnlyVisibility(visibility: string | undefined): boolean {
  return visibility === "link_read" || visibility === "link_read_write";
}

/** Only `public_read` apps belong in the global Community catalog. */
export function isPublicCommunityVisibility(visibility: string | undefined): boolean {
  return visibility === "public_read";
}

/** One image or video on a catalog listing. role=cover drives cards; gallery = details page. */
export interface CatalogMediaItem {
  kind: "image" | "video";
  url: string;
  role: "cover" | "gallery";
  posterUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface CommunityCatalogEntry {
  /** Stable key for React lists */
  catalogId: string;
  source: CommunityCatalogSource;
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  icon?: string;
  platform?: string[];
  /** True when full functionality needs Paprwork desktop (not just apps.papr.ai preview). */
  requiresDesktopForFullFunctionality?: boolean;
  requirements?: RequirementItem[];
  minPaprworkVersion?: string;
  /** Open-source bundle fields */
  bundleId?: string;
  path?: string;
  /** Papr Cloud fields */
  appId?: string;
  namespaceId?: string;
  slug?: string | null;
  liveUrl?: string | null;
  /** Can install/sync source into Paprwork */
  codeInstallable: boolean;
  /** Has a live web app URL */
  liveViewable: boolean;
  /** Current user published this app (not merely installed a teammate copy) */
  isOwned?: boolean;
  /** Number of local fork/track copies installed from this catalog entry */
  installedForkCount?: number;
  /** Everyone who installed it (fork or collaborate), from Papr Cloud. */
  installCount?: number;
  /** Last time the publisher published this app (ISO 8601). */
  updatedAt?: string;
  /** Cloud publish visibility (team, public_read, …) when known */
  visibility?: string;
  /** External invite link enabled (unlisted — not Community Apps listed) */
  shareLinkEnabled?: boolean;
  /** Memory server: false for specific-people / team shares not in global Community */
  communityCatalogListed?: boolean;
  /** Publisher Papr user id — used to hide own apps from Shared with me */
  publisherUserId?: string;
  /** Broad category the publisher's app was sorted into (set at publish). */
  category?: string;
  /** Editorial headline for the Community featured banner (publisher-set). */
  headline?: string;
  /** Ordered listing media from the catalog record (cover + details gallery). */
  media?: CatalogMediaItem[];
  /** Card cover picture (derived from media: image cover, or a video cover's poster). */
  coverUrl?: string;
  /** Card preview loop (derived from media: video cover). */
  coverVideoUrl?: string;
  /** Scheduled job summary (denormalized at publish time) */
  catalogAutomation?: CatalogAutomation;
}

export interface CommunityCatalog {
  schemaVersion: string;
  scope: CommunityCatalogScope;
  entries: CommunityCatalogEntry[];
  sources: {
    opensource: number;
    cloud: number;
  };
  /** When namespace workspace catalog used client-side fallback (no dedicated memory route) */
  fallbackUsed?: boolean;
  namespaceId?: string;
  /** True when served from an in-process cache (may be stale). */
  fromCache?: boolean;
}
