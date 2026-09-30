/**
 * Pure decision logic for track-mode pull-on-publish.
 */

import type { CloudAppInstallMode, CloudAppLineageFile } from "../../../core/types/cloudAppLineage.js";

export type TrackPullSkipReason =
  | "not_track"
  | "no_lineage"
  | "auto_pull_disabled"
  | "no_live_revision"
  | "same_revision";

export type TrackPullDecision =
  | { action: "skip"; reason: TrackPullSkipReason }
  | { action: "pull" };

export function decideTrackPullAction(input: {
  mode: CloudAppInstallMode | undefined;
  lineage: Pick<CloudAppLineageFile, "upstreamRevision" | "trackAutoPull"> | null;
  liveRevision: string | null;
}): TrackPullDecision {
  if (input.mode !== "track") {
    return { action: "skip", reason: "not_track" };
  }
  if (!input.lineage) {
    return { action: "skip", reason: "no_lineage" };
  }
  if (input.lineage.trackAutoPull === false) {
    return { action: "skip", reason: "auto_pull_disabled" };
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
