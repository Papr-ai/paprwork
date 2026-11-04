/**
 * Lineage hints for cloud publish tools (track collaborators vs owners).
 */

import type { CloudLineageAppEntry } from "../../gateway/services/CloudAppLineageService.js";
import { isOnTeamData } from "./copyAxes.js";

export interface PublishLineageSummary {
  mode: "fork" | "track";
  sourceSlug: string;
  sourceAppId: string;
  sourceNamespaceId: string;
  databasePolicy?: "shared" | "forked";
  sourceAudience?: "team" | "people" | "community";
}

export function toPublishLineageSummary(
  entry: CloudLineageAppEntry | null,
): PublishLineageSummary | null {
  if (!entry) {
    return null;
  }
  return {
    mode: entry.mode,
    sourceSlug: entry.sourceSlug,
    sourceAppId: entry.sourceAppId,
    sourceNamespaceId: entry.sourceNamespaceId,
    ...(entry.databasePolicy ? { databasePolicy: entry.databasePolicy } : {}),
    ...(entry.sourceAudience ? { sourceAudience: entry.sourceAudience } : {}),
  };
}

const TRACK_COLLABORATOR_WARNING =
  "This copy is on the team's live data, so publish_cloud_app is refused for it. Its code reaches the team through submit_cloud_app_pr. " +
  "To ship code: push_cloud_sync({ appId }) then submit_cloud_app_pr. " +
  "When the user asks to publish (not just propose), always call submit_cloud_app_pr({ publishNow: true }); you can't look up their role, so don't guess it. " +
  "A Maintainer or Admin of the source app goes straight to the live app with no owner review. " +
  "Anyone else is sent for review automatically and publishNote says why (\"You can propose changes to this app, but not publish them directly.\" means their role). " +
  "Then tell them it went to the owner for review, and that the owner can make them a Maintainer in the app's sharing settings if they want to publish directly. " +
  "To ship shared database rows: push_cloud_sync({ appId }) (or targets: ['turso']) and confirm turso.sources[].pendingPush is clear in get_cloud_sync_status. " +
  "The live team URL stays on the publisher's slug. A proposal reaches it once the owner approves it. A publishNow from a Maintainer/Admin reaches it right away.";

export function trackCollaboratorPublishWarning(
  entry: CloudLineageAppEntry | null,
): string | null {
  // v5: copies on their own data publish to their own link like any app.
  if (!entry || !isOnTeamData(entry)) {
    return null;
  }
  return TRACK_COLLABORATOR_WARNING;
}

export function appendLineageToPublishData(
  data: Record<string, unknown>,
  entry: CloudLineageAppEntry | null,
): Record<string, unknown> {
  const lineage = toPublishLineageSummary(entry);
  const trackInstallWarning = trackCollaboratorPublishWarning(entry);
  return {
    ...data,
    lineage,
    ...(trackInstallWarning ? { trackInstallWarning } : {}),
  };
}
