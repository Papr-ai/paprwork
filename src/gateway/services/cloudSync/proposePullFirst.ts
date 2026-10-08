/**
 * Pull the publisher's latest into an installed copy before proposing.
 *
 * Used by both proposal paths — the Send to owner button
 * (POST /api/cloud/apps/changes) and Pen's submit_cloud_app_pr — so a proposal
 * never carries files the publisher has changed since. If the pull finds files
 * changed on both sides, nothing is applied and the caller must stop and ask
 * the user (Keep mine / Take theirs / merge) before proposing.
 */

export interface ProposePullConflict {
  conflictFiles: string[];
  updatedFiles: string[];
  mergedFiles: string[];
}

export interface ProposePullFirstDeps {
  checkUpstream: (appId: string) => Promise<{ publisherUpdatesAvailable?: boolean }>;
  syncTrackApp: (appId: string) => Promise<{
    conflictFiles: string[];
    updatedFiles: string[];
    mergedFiles?: string[];
  }>;
}

async function defaultDeps(): Promise<ProposePullFirstDeps> {
  const { checkPublisherUpstreamRevision } = await import(
    "../syncV3/checkPublisherUpstreamRevision.js"
  );
  const { getCloudAppTrackSyncService } = await import("../CloudAppTrackSyncService.js");
  return {
    checkUpstream: checkPublisherUpstreamRevision,
    syncTrackApp: (appId) => getCloudAppTrackSyncService().syncTrackApp(appId),
  };
}

/** Returns null when the copy is up to date (or was brought up to date cleanly). */
export async function pullPublisherBeforePropose(
  installedAppId: string,
  deps?: ProposePullFirstDeps,
): Promise<ProposePullConflict | null> {
  const d = deps ?? (await defaultDeps());
  const upstream = await d.checkUpstream(installedAppId);
  if (!upstream.publisherUpdatesAvailable) {
    return null;
  }
  const pulled = await d.syncTrackApp(installedAppId);
  if (pulled.conflictFiles.length === 0) {
    return null;
  }
  return {
    conflictFiles: pulled.conflictFiles,
    updatedFiles: pulled.updatedFiles,
    mergedFiles: pulled.mergedFiles ?? [],
  };
}

export const PROPOSE_CONFLICT_MESSAGE =
  "The owner changed the same files you edited. Nothing was sent. " +
  "Resolve them with Get updates (Keep mine / Take theirs), then send again.";
