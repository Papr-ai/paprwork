/**
 * Shared Community / Team cloud install rules — used by UI and agent tools.
 */

import type { CommunityCatalogScope } from "../types/communityCatalog.js";
import { isTeamSharedVisibility } from "../types/communityCatalog.js";
import type { CloudAppInstallMode } from "../types/cloudAppLineage.js";

export interface CloudCatalogInstallModeOption {
  mode: CloudAppInstallMode;
  label: string;
  description: string;
}

export const COMMUNITY_FORK_OPTION: CloudCatalogInstallModeOption = {
  mode: "fork",
  label: "Install copy",
  description:
    "Independent copy with a fresh database. Schema from migrations, empty rows.",
};

export const TEAM_FORK_OPTION: CloudCatalogInstallModeOption = {
  mode: "fork",
  label: "My own database (empty)",
  description:
    "Independent copy with a fresh database. Your edits won't affect teammates.",
};

export const TEAM_TRACK_OPTION: CloudCatalogInstallModeOption = {
  mode: "track",
  label: "Shared team database",
  description:
    "Same data as the web app — collaborate on the publisher's database and pull code updates when ready.",
};

/** True when UI shows the fork vs collaborate modal (team-shared + forkable). */
export function requiresInstallModeChoice(input: {
  catalogScope: CommunityCatalogScope;
  visibility?: string;
  codeInstallable: boolean;
}): boolean {
  if (!input.codeInstallable) {
    return false;
  }
  return (
    input.catalogScope === "namespace" &&
    isTeamSharedVisibility(input.visibility)
  );
}

/** Install modes offered for this catalog row (matches CloudCatalogInstallModal). */
export function getCloudCatalogInstallModeOptions(input: {
  catalogScope: CommunityCatalogScope;
  visibility?: string;
  codeInstallable: boolean;
}): CloudCatalogInstallModeOption[] {
  if (!input.codeInstallable) {
    return [COMMUNITY_FORK_OPTION];
  }
  if (requiresInstallModeChoice(input)) {
    return [TEAM_FORK_OPTION, TEAM_TRACK_OPTION];
  }
  return input.catalogScope === "namespace"
    ? [TEAM_FORK_OPTION]
    : [COMMUNITY_FORK_OPTION];
}

export function resolveAutomaticInstallMode(input: {
  catalogScope: CommunityCatalogScope;
  visibility?: string;
  codeInstallable: boolean;
}): CloudAppInstallMode | null {
  if (requiresInstallModeChoice(input)) {
    return null;
  }
  return "fork";
}

export function catalogScopeFromBrowseScope(
  scope: "community" | "team",
): CommunityCatalogScope {
  return scope === "team" ? "namespace" : "global";
}

export function browseScopeFromCatalogScope(
  catalogScope: CommunityCatalogScope,
): "community" | "team" {
  return catalogScope === "namespace" ? "team" : "community";
}
