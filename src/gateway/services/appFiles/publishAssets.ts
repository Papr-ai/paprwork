/**
 * Publish-time resolution of `app_files` rows.
 *
 * This is the phase that closes the original bug. A mini-app that references a
 * 60 MB video could previously publish "successfully" and serve a broken asset,
 * because the bytes were dropped from the git sync with nothing but a console
 * warning. Publishing now has an opinion about those bytes: it either makes
 * them reachable, or it refuses and says why.
 *
 * Two rules do the work:
 *
 *   - A file that cannot be served must block the publish. Shipping a broken
 *     asset is worse than not shipping, because the failure surfaces to the
 *     app's visitors instead of to its author.
 *   - A file that is private must stay private. `isPublishable()` is the
 *     meeting-recording guarantee, and it is enforced here as well as
 *     server-side, so a bug in either layer alone cannot expose a recording.
 */

import type { AppFileRow } from "./appFilesSchema.js";
import { isPublishable } from "./appFilesSchema.js";

/** A file that would ship broken, with the reason stated in the author's terms. */
export interface BlockingAsset {
  fileName: string;
  objectKey: string;
  reason: string;
}

export interface PublishAssetPlan {
  /** Objects to flip CDN-public. Excludes user-scoped and opt-out files. */
  toPublish: AppFileRow[];
  /** Objects that must be private: user-scoped, or explicitly opted out. */
  toKeepPrivate: AppFileRow[];
  /** Non-empty means publish must not proceed. */
  blocking: BlockingAsset[];
}

/**
 * Decide what publishing should do with an app's files.
 *
 * Pure: no network, no database, no filesystem. The decision is the part worth
 * testing exhaustively, so it is separated from the acting.
 */
export function planPublishAssets(rows: readonly AppFileRow[]): PublishAssetPlan {
  const toPublish: AppFileRow[] = [];
  const toKeepPrivate: AppFileRow[] = [];
  const blocking: BlockingAsset[] = [];

  for (const row of rows) {
    if (!isPublishable(row)) {
      // Never publish these, and never block on them either — a private file
      // that only exists locally is a perfectly valid state for a public app.
      toKeepPrivate.push(row);
      continue;
    }

    if (row.upload_state !== "verified") {
      // A local-only file is fine on the desktop and broken on the web: the
      // cloud runtime has no filesystem to read it from. Catch it here rather
      // than let a visitor find it.
      blocking.push({
        fileName: row.file_name,
        objectKey: row.object_key,
        reason:
          row.upload_state === "failed"
            ? "its upload failed, so the cloud has no copy to serve"
            : `its upload is still ${row.upload_state}, so the cloud has no copy to serve`,
      });
      continue;
    }

    toPublish.push(row);
  }

  return { toPublish, toKeepPrivate, blocking };
}

/**
 * Turn blocking assets into a message the author can act on.
 *
 * "Publish failed" tells someone nothing. This names the files, says why, and
 * gives the one action that fixes it.
 */
export function describeBlockingAssets(blocking: readonly BlockingAsset[]): string {
  const lines = blocking.map((b) => `  • ${b.fileName} — ${b.reason}`);
  const noun = blocking.length === 1 ? "file" : "files";
  return (
    `Cannot publish: ${blocking.length} ${noun} would be unavailable to visitors.\n` +
    `${lines.join("\n")}\n` +
    `Re-upload from App Files, or remove the reference, then publish again.`
  );
}
