/**
 * Unified Community Apps catalog — open-source bundles + Papr Cloud public apps.
 */

import type { RequirementItem } from "./bundles.js";

export type CommunityCatalogSource = "opensource" | "cloud";

/** Which Apps tab catalog scope to load. */
export type CommunityCatalogScope = "global" | "namespace";

export function isTeamSharedVisibility(visibility: string | undefined): boolean {
  if (!visibility) return false;
  return visibility === "team" || visibility.startsWith("team_");
}

/** Only `public_read` apps belong in the global Community catalog. */
export function isPublicCommunityVisibility(visibility: string | undefined): boolean {
  return visibility === "public_read";
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
  /** Local user already owns the publisher app ID */
  isOwned?: boolean;
  /** Number of local fork/track copies installed from this catalog entry */
  installedForkCount?: number;
  /** Cloud publish visibility (team, public_read, …) when known */
  visibility?: string;
  /** Publisher Papr user id — used to hide own apps from Shared with me */
  publisherUserId?: string;
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
}
