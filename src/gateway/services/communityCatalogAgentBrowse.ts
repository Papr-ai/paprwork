/**
 * Agent-facing Community / Team catalog — same forkable listings as the Apps UI.
 */

import type {
  CommunityCatalogEntry,
  CommunityCatalogScope,
} from "../../core/types/communityCatalog.js";
import {
  browseScopeFromCatalogScope,
  getCloudCatalogInstallModeOptions,
  requiresInstallModeChoice,
  type CloudCatalogInstallModeOption,
} from "../../core/utils/cloudCatalogInstallPolicy.js";
import { isCommunityBrowseListing } from "./CommunityCatalogService.js";

export type AgentCommunityBrowseScope = "community" | "team";

export function agentBrowseScopeToCatalogScope(
  scope: AgentCommunityBrowseScope,
): CommunityCatalogScope {
  return scope === "team" ? "namespace" : "global";
}

/** Matches Community Apps tab: codeInstallable cloud apps only (no preview-only). */
export function filterCustomizableCatalogEntries(
  entries: readonly CommunityCatalogEntry[],
  catalogScope: CommunityCatalogScope,
): CommunityCatalogEntry[] {
  return entries.filter((entry) => {
    if (catalogScope === "namespace" && entry.source === "opensource") {
      return false;
    }
    return isCommunityBrowseListing(entry);
  });
}

export function matchesCommunityCatalogQuery(
  entry: CommunityCatalogEntry,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return (
    entry.name.toLowerCase().includes(q) ||
    entry.description.toLowerCase().includes(q) ||
    entry.author.toLowerCase().includes(q) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(q))
  );
}

export interface AgentCommunityAppListing {
  name: string;
  description: string;
  namespaceId: string;
  slug: string;
  author: string;
  tags: string[];
  visibility?: string;
  catalogScope: "community" | "team";
  requiresInstallModeChoice: boolean;
  isOwned: boolean;
  requirementsCount: number;
  installOptions: CloudCatalogInstallModeOption[];
  installCommand: string | null;
}

function formatInstallCommand(input: {
  namespaceId: string;
  slug: string;
  catalogScope: "community" | "team";
  visibility?: string;
  mode: "fork" | "track";
}): string {
  const visibilityPart = input.visibility
    ? `, visibility: "${input.visibility}"`
    : "";
  return `install_cloud_app({ namespaceId: "${input.namespaceId}", slug: "${input.slug}", catalogScope: "${input.catalogScope}"${visibilityPart}, mode: "${input.mode}" })`;
}

export function toAgentCommunityAppListing(
  entry: CommunityCatalogEntry,
  catalogScope: CommunityCatalogScope,
): AgentCommunityAppListing | null {
  const namespaceId = entry.namespaceId?.trim();
  const slug = entry.slug?.trim();
  if (!namespaceId || !slug) {
    return null;
  }

  const browseScope = browseScopeFromCatalogScope(catalogScope);
  const codeInstallable = entry.codeInstallable === true;
  const policyInput = {
    catalogScope,
    visibility: entry.visibility,
    codeInstallable,
  };
  const installOptions = getCloudCatalogInstallModeOptions(policyInput);
  const needsChoice = requiresInstallModeChoice(policyInput);
  const isOwned = entry.isOwned === true;

  return {
    name: entry.name,
    description: entry.description,
    namespaceId,
    slug,
    author: entry.author,
    tags: entry.tags,
    visibility: entry.visibility,
    catalogScope: browseScope,
    requiresInstallModeChoice: needsChoice,
    isOwned,
    requirementsCount: entry.requirements?.length ?? 0,
    installOptions,
    installCommand: isOwned
      ? null
      : needsChoice
        ? null
        : formatInstallCommand({
            namespaceId,
            slug,
            catalogScope: browseScope,
            visibility: entry.visibility,
            mode: "fork",
          }),
  };
}

export function buildAgentCommunityAppListings(
  entries: readonly CommunityCatalogEntry[],
  catalogScope: CommunityCatalogScope,
  query?: string,
): AgentCommunityAppListing[] {
  const trimmedQuery = query?.trim() ?? "";
  const listings: AgentCommunityAppListing[] = [];

  for (const entry of filterCustomizableCatalogEntries(entries, catalogScope)) {
    if (trimmedQuery && !matchesCommunityCatalogQuery(entry, trimmedQuery)) {
      continue;
    }
    const listing = toAgentCommunityAppListing(entry, catalogScope);
    if (listing) {
      listings.push(listing);
    }
  }

  listings.sort((left, right) => left.name.localeCompare(right.name));
  return listings;
}
