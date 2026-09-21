/**
 * Compare stored upstream revision (lineage file) vs live publisher app-revision.json.
 * Piggybacks on the same remote-code-status fetch the publish bar already runs after sync refresh.
 */

import { promises as fs } from "fs";
import path from "path";
import { getPaprAppsRoot } from "../../../core/utils/paprRoot.js";
import { parseCloudAppLineageFile } from "../../../core/utils/cloudAppLineage.js";
import { CLOUD_LINEAGE_FILENAME } from "../CloudAppLineageService.js";
import { fetchPublishedAppRevision } from "../cloudSync/trackUpstreamRevision.js";

export interface PublisherUpstreamRevisionStatus {
  publisherUpdatesAvailable: boolean;
  liveRevision: string | null;
  storedUpstreamRevision: string | null;
  reason: string;
}

export async function checkPublisherUpstreamRevision(
  appId: string,
): Promise<PublisherUpstreamRevisionStatus> {
  const trimmed = appId.trim();
  const empty: PublisherUpstreamRevisionStatus = {
    publisherUpdatesAvailable: false,
    liveRevision: null,
    storedUpstreamRevision: null,
    reason: "no lineage",
  };
  if (!trimmed) {
    return { ...empty, reason: "appId required" };
  }

  const filePath = path.join(getPaprAppsRoot(), trimmed, CLOUD_LINEAGE_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return empty;
  }

  const lineage = parseCloudAppLineageFile(raw);
  if (!lineage) {
    return empty;
  }

  const liveRevision = await fetchPublishedAppRevision(
    lineage.source.namespaceId,
    lineage.source.slug,
  );
  const storedUpstreamRevision = lineage.upstreamRevision?.trim() || null;

  if (!liveRevision) {
    return {
      publisherUpdatesAvailable: false,
      liveRevision: null,
      storedUpstreamRevision,
      reason: "publisher revision unavailable",
    };
  }

  if (!storedUpstreamRevision) {
    return {
      publisherUpdatesAvailable: true,
      liveRevision,
      storedUpstreamRevision: null,
      reason: "no stored upstream revision",
    };
  }

  const publisherUpdatesAvailable = liveRevision !== storedUpstreamRevision;
  return {
    publisherUpdatesAvailable,
    liveRevision,
    storedUpstreamRevision,
    reason: publisherUpdatesAvailable
      ? "publisher shipped a newer revision"
      : "matches publisher revision",
  };
}
