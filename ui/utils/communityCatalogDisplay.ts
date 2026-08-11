/**
 * Human-readable labels for Community / Team app catalog cards.
 * Filters internal catalog tags (cloud, team, public) that are not app metadata.
 */

import type { CommunityCatalogEntry } from "../../src/core/types/communityCatalog";
import { isTeamSharedVisibility } from "../../src/core/types/communityCatalog";
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
  if (entry.visibility === "public_read") {
    return "Public app";
  }
  return null;
}

/** Single author line under the description. */
export function getCatalogByline(entry: CommunityCatalogEntry): string {
  const author = entry.author?.trim() || "Unknown";
  if (entry.source === "cloud") {
    return `By ${author}`;
  }
  return `Version ${entry.version} · By ${author}`;
}
