/**
 * Shared Community / Team cloud install rules — used by UI and agent tools.
 */

import type { CommunityCatalogScope } from "../types/communityCatalog.js";
import { isTeamSharedVisibility } from "../types/communityCatalog.js";
import type { CloudAppInstallMode } from "../types/cloudAppLineage.js";

/** Runtime install pipeline policy (matches gateway cloudInstallDbPolicy). */
export type CloudCatalogInstallDbPolicy = "fork_empty" | "shared_primary";

export interface CloudCatalogInstallModeOption {
  mode: CloudAppInstallMode;
  /** Which database policy this choice applies (DATA axis, distinct from mode). */
  installDbPolicy: CloudCatalogInstallDbPolicy;
  label: string;
  description: string;
}

export function cloudCatalogInstallOptionKey(
  option: Pick<CloudCatalogInstallModeOption, "mode" | "installDbPolicy">,
): string {
  return `${option.mode}:${option.installDbPolicy}`;
}

export const COMMUNITY_FORK_OPTION: CloudCatalogInstallModeOption = {
  mode: "fork",
  installDbPolicy: "fork_empty",
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
  installDbPolicy: "fork_empty",
  label: "Collaborate (no data sharing)",
  description:
    "Your own private data, still linked to the original: pull the author's updates and propose your changes back.",
};

export const TEAM_FORK_OPTION: CloudCatalogInstallModeOption = {
  mode: "fork",
  installDbPolicy: "fork_empty",
  label: "Install a copy",
  description:
    "Independent copy with a fresh database. No link to the original — your edits won't affect teammates.",
};

export const TEAM_TRACK_NO_DATA_OPTION: CloudCatalogInstallModeOption = {
  mode: "track",
  installDbPolicy: "fork_empty",
  label: "Collaborate (no data sharing)",
  description:
    "Your own private database, still linked to the team app: pull code updates and propose changes without sharing rows with teammates.",
};

export const TEAM_TRACK_SHARED_DATA_OPTION: CloudCatalogInstallModeOption = {
  mode: "track",
  installDbPolicy: "shared_primary",
  label: "Collaborate (data sharing)",
  description:
    "Same data as the web app — collaborate on the shared team database and pull code updates when ready.",
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
    return [
      TEAM_FORK_OPTION,
      TEAM_TRACK_NO_DATA_OPTION,
      TEAM_TRACK_SHARED_DATA_OPTION,
    ];
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
