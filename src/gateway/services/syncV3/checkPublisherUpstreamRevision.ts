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
import { buildCloudPreviewAuthHeaders } from "../appRuntime/cloudPreviewRuntimeAuth.js";

/**
 * Team apps are not public: an anonymous fetch of app-revision.json gets 403,
 * which read as "revision unavailable" and made the chip claim "In sync with
 * publisher" while the publisher had shipped changes. Retry signed in.
 */
async function fetchPublisherRevisionSignedIn(
  namespaceId: string,
  slug: string,
): Promise<string | null> {
  const anonymous = await fetchPublishedAppRevision(namespaceId, slug);
  if (anonymous) return anonymous;
  try {
    const headers = await buildCloudPreviewAuthHeaders(
      { namespaceId, slug },
      { enrichFromSession: true },
    );
    return await fetchPublishedAppRevision(namespaceId, slug, headers);
  } catch {
    return null;
  }
}

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

  // Plain forks are the user's own app: they are never "behind the publisher".
  if (lineage.mode !== "track") {
    return { ...empty, reason: "plain fork: not linked to the publisher" };
  }

  const liveRevision = await fetchPublisherRevisionSignedIn(
    lineage.source.namespaceId,
    lineage.source.slug,
  );
  // Installs made before upstreamRevision was recorded have none. The live
  // revision is the first 16 hex of sha256(dist/app.js), which the sync
  // snapshot already holds, so derive it rather than report a false "update".
  const snapshotDist = lineage.syncSnapshot?.["dist/app.js"];
  const storedUpstreamRevision =
    lineage.upstreamRevision?.trim() ||
    (snapshotDist ? snapshotDist.slice(0, 16).toLowerCase() : null);

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
