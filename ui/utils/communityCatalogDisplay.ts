/**
 * Human-readable labels for Community / Team app catalog cards.
 * Filters internal catalog tags (cloud, team, public) that are not app metadata.
 */

import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";
import {
  isLinkOnlyVisibility,
  isTeamSharedVisibility,
} from "../../src/core/types/communityCatalog";
import { formatCatalogDisplayTags } from "../../src/core/utils/catalogTags";

/** Tags shown on cards — human labels from publish metadata, no internal markers. */
export function filterCatalogDisplayTags(tags: string[] | undefined): string[] {
  return formatCatalogDisplayTags(tags);
}

/** Short share-type pill on the card title row. */
export function getCatalogShareBadge(entry: CommunityCatalogEntry): string | null {
  if (entry.source === "opensource") {
    return "Open source";
  }
  if (isTeamSharedVisibility(entry.visibility)) {
    return "Team app";
  }
  if (
    isLinkOnlyVisibility(entry.visibility) ||
    entry.shareLinkEnabled === true ||
    entry.liveUrl?.includes("?t=")
  ) {
    return "Invite link";
  }
  return null;
}

/** "3d ago" style relative time for catalog footers. */
export function formatCatalogUpdated(iso?: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = s / 60, h = m / 60, d = h / 24;
  if (m < 60) return `${Math.floor(m)}m ago`;
  if (h < 24) return `${Math.floor(h)}h ago`;
  if (d < 30) return `${Math.floor(d)}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/** Single author line under the description. */
export function getCatalogByline(entry: CommunityCatalogEntry): string {
  const author = entry.author?.trim() || "Unknown";
  if (entry.source === "cloud") {
    return `By ${author}`;
  }
  return `Version ${entry.version} · By ${author}`;
}
