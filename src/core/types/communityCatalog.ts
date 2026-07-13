/**
 * Unified Community Apps catalog — open-source bundles + Papr Cloud public apps.
 */

import type { RequirementItem } from "./bundles.js";

export type CommunityCatalogSource = "opensource" | "cloud";

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
}

export interface CommunityCatalog {
  schemaVersion: string;
  entries: CommunityCatalogEntry[];
  sources: {
    opensource: number;
    cloud: number;
  };
}
