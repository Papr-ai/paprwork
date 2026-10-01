/**
 * v5 copy axes, shared by the UI bar (ui/utils/copyState.ts) and gateway
 * guards (publish, data switch) so both read lineage the same way.
 */

import type { CloudAppLineageFile } from "../types/cloudAppLineage.js";

export type CopyLink = "linked" | "detached";
export type CopyDataMode = "own" | "team";
export type CopyOrigin = "community" | "team";

export class InvalidCopyStateError extends Error {}

/** Throws on combinations the product must never show. */
export function assertValidCopyState(s: { link: CopyLink; dataMode: CopyDataMode; origin: CopyOrigin }): void {
  if (s.dataMode === "team" && s.link === "detached") {
    throw new InvalidCopyStateError("A detached copy can't use the team's data");
  }
  if (s.dataMode === "team" && s.origin !== "team") {
    throw new InvalidCopyStateError("Only team apps can use team data");
  }
}

/**
 * Derive the v5 axes from the two lineage fields the rest of the system
 * already routes on, so the bar can never disagree with where data goes:
 *   mode            track → linked, fork → detached (Detach writes fork)
 *   databasePolicy  shared → team data (same rule as
 *                   lineageUsesSharedPrimaryDatabase), forked → own data
 *   sourceAudience  team | people → team origin, community → community
 * There are deliberately no separate link/dataMode fields: a second copy of
 * the same fact is how the old bar drifted. The data switch (phase 5) will
 * change databasePolicy itself.
 */
export function copyAxesFromLineage(
  lineage: Pick<CloudAppLineageFile, "mode" | "databasePolicy" | "sourceAudience">,
): { link: CopyLink; dataMode: CopyDataMode; origin: CopyOrigin } {
  const link: CopyLink = lineage.mode === "track" ? "linked" : "detached";
  const shared =
    lineage.databasePolicy === "shared" ||
    (lineage.databasePolicy === undefined && lineage.mode === "track");
  const origin: CopyOrigin =
    lineage.sourceAudience === "community"
      ? "community"
      : lineage.sourceAudience === "team" || lineage.sourceAudience === "people"
        ? "team"
        : shared
          ? "team"
          : "community";
  // A shared database on a detached or Community copy can't be shown as
  // "team data" (no Propose path exists for it). Surface it as own data;
  // isOnTeamData() below still reports the real routing for guards.
  const dataMode: CopyDataMode = shared && link === "linked" && origin === "team" ? "team" : "own";
  return { link, dataMode, origin };
}

/**
 * This copy writes the publisher's shared database (same rule as
 * lineageUsesSharedPrimaryDatabase). Guards use this, not the display axes:
 * any copy on shared data must not publish its own code or detach.
 */
export function usesSharedData(
  lineage: Pick<CloudAppLineageFile, "mode" | "databasePolicy"> | null | undefined,
): boolean {
  if (!lineage) return false;
  if (lineage.databasePolicy === "forked") return false;
  if (lineage.databasePolicy === "shared") return true;
  return lineage.mode === "track";
}

/** Kept for call sites written against the v5 name. */
export const isOnTeamData = usesSharedData;
