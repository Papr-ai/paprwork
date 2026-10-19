/**
 * Pure decision logic for track-mode pull-on-publish.
 */

import type { CloudAppInstallMode, CloudAppLineageFile } from "../../../core/types/cloudAppLineage.js";

export type TrackPullSkipReason =
  | "not_track"
  | "no_lineage"
  | "auto_pull_disabled"
  | "no_live_revision"
  | "same_revision"
  | "updates_paused";

export type TrackPullDecision =
  | { action: "skip"; reason: TrackPullSkipReason }
  | { action: "pull" };

/** Paused copies are re-checked in the background at most once a day. */
export const PAUSED_RECHECK_MS = 24 * 60 * 60 * 1000;

export function pausedRecheckDue(pausedAt: string, now = Date.now()): boolean {
  const at = Date.parse(pausedAt);
  return !Number.isFinite(at) || now - at >= PAUSED_RECHECK_MS;
}

export function decideTrackPullAction(input: {
  mode: CloudAppInstallMode | undefined;
  lineage: Pick<CloudAppLineageFile, "upstreamRevision" | "trackAutoPull" | "updatesPaused"> | null;
  liveRevision: string | null;
  now?: number;
}): TrackPullDecision {
  if (input.mode !== "track") {
    return { action: "skip", reason: "not_track" };
  }
  if (!input.lineage) {
    return { action: "skip", reason: "no_lineage" };
  }
  // v5: code only changes when the user asks. Auto-pull is an explicit opt-in.
  if (input.lineage.trackAutoPull !== true) {
    return { action: "skip", reason: "auto_pull_disabled" };
  }
  // Publisher refused (no access / code sharing off). Don't retry on a timer:
  // re-checked when the user opens Get updates, or by the daily re-check.
  if (input.lineage.updatesPaused && !pausedRecheckDue(input.lineage.updatesPaused.at, input.now)) {
    return { action: "skip", reason: "updates_paused" };
  }
  if (!input.liveRevision) {
    return { action: "skip", reason: "no_live_revision" };
  }
  if (
    input.lineage.upstreamRevision &&
    input.liveRevision === input.lineage.upstreamRevision
  ) {
    return { action: "skip", reason: "same_revision" };
  }
  return { action: "pull" };
}
