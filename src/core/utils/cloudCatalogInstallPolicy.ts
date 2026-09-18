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
  label: "Install a copy",
  description:
    "Yours to change freely. No link to the original — no updates, no way to send changes back.",
};

/**
 * Community collaborate. Same private database as a fork (public catalog data
 * is never shared), but the install keeps its upstream lineage — so the app
 * can pull the publisher's updates and open Propose changes against it.
 */
export const COMMUNITY_TRACK_OPTION: CloudCatalogInstallModeOption = {
  mode: "track",
  label: "Collaborate on it",
  description:
    "Your own private data, still linked to the original: pull the author's updates and propose your changes back.",
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

/**
 * True when the UI shows the copy vs collaborate modal.
 *
 * Community apps now ask too. Installing used to silently fork, which is the
 * right default for "I just want to run this" and the wrong one for "I want
 * to help build this" — and the second intent had no path at all, so people
 * forked and then had to ask how to undo it.
 */
export function requiresInstallModeChoice(input: {
  catalogScope: CommunityCatalogScope;
  visibility?: string;
  codeInstallable: boolean;
}): boolean {
  if (!input.codeInstallable) {
    return false;
  }
  if (input.catalogScope === "global") {
    return true;
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
  // Community and team both offer a choice, but they mean different things:
  // team collaborate shares one database, community collaborate shares only
  // code. The wording has to say which, or the modal is a coin flip.
  if (input.catalogScope === "global") {
    return [COMMUNITY_FORK_OPTION, COMMUNITY_TRACK_OPTION];
  }
  if (requiresInstallModeChoice(input)) {
    return [TEAM_FORK_OPTION, TEAM_TRACK_OPTION];
  }
  return [TEAM_FORK_OPTION];
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
