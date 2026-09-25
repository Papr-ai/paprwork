/**
 * Lineage hints for cloud publish tools (track collaborators vs owners).
 */

import type { CloudLineageAppEntry } from "../../gateway/services/CloudAppLineageService.js";

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
  "This app is a track install (collaborate with upstream). publish_cloud_app updates Memory sharing for YOUR local app id and slug — it does NOT refresh the publisher's live apps.papr.ai URL. " +
  "To ship code: push_cloud_sync({ appId }) then submit_cloud_app_pr. " +
  "To ship shared database rows: push_cloud_sync({ appId }) (or targets: ['turso']) and confirm turso.sources[].pendingPush is clear in get_cloud_sync_status. " +
  "The live team URL stays on the publisher's slug until they merge your PR and publish.";

export function trackCollaboratorPublishWarning(
  entry: CloudLineageAppEntry | null,
): string | null {
  if (!entry || entry.mode !== "track") {
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
