/**
 * Applies a `PublishAssetPlan` by flipping CDN visibility on the objects.
 *
 * Split from `planPublishAssets` on purpose: deciding is pure and heavily
 * tested, acting talks to the network and is thin enough to read in one go.
 */

import type { AppFileRow } from "./appFilesSchema.js";
import { isPublishable } from "./appFilesSchema.js";
import {
  describeBlockingAssets,
  planPublishAssets,
  type PublishAssetPlan,
} from "./publishAssets.js";

export interface VisibilitySetter {
  (appId: string, objectKey: string, isPublic: boolean): Promise<unknown>;
}

export interface ApplyResult {
  flipped: string[];
  failed: { objectKey: string; error: string }[];
}

/**
 * Make an app's publishable objects CDN-readable.
 *
 * Throws before touching anything if any asset would ship broken — a partial
 * flip followed by a failed publish would leave objects public for an app that
 * is not live.
 */
export async function applyPublishVisibility(
  appId: string,
  rows: readonly AppFileRow[],
  setVisibility: VisibilitySetter,
): Promise<{ plan: PublishAssetPlan; result: ApplyResult }> {
  const plan = planPublishAssets(rows);

  if (plan.blocking.length > 0) {
    throw new Error(describeBlockingAssets(plan.blocking));
  }

  const result = await flipAll(appId, plan.toPublish, true, setVisibility);

  // One object failing to flip means one broken asset on a live app. Surface it
  // rather than reporting a clean publish.
  if (result.failed.length > 0) {
    const detail = result.failed
      .map((f) => `${f.objectKey} (${f.error})`)
      .join(", ");
    throw new Error(
      `Published app assets could not be made public: ${detail}. ` +
        `The app may serve broken files until this is retried.`,
    );
  }

  return { plan, result };
}

/**
 * Return an app's objects to private when it is unpublished.
 *
 * Best-effort by design: unpublishing must always succeed. A stranded public
 * object is a leak, so failures are reported to the caller for logging, but
 * they never prevent the app from coming down.
 */
export async function revokePublishVisibility(
  appId: string,
  rows: readonly AppFileRow[],
  setVisibility: VisibilitySetter,
): Promise<ApplyResult> {
  const published = rows.filter(
    (row) => isPublishable(row) && row.upload_state === "verified",
  );
  return flipAll(appId, published, false, setVisibility);
}

async function flipAll(
  appId: string,
  rows: readonly AppFileRow[],
  isPublic: boolean,
  setVisibility: VisibilitySetter,
): Promise<ApplyResult> {
  const flipped: string[] = [];
  const failed: { objectKey: string; error: string }[] = [];

  for (const row of rows) {
    try {
      await setVisibility(appId, row.object_key, isPublic);
      flipped.push(row.object_key);
    } catch (error) {
      failed.push({
        objectKey: row.object_key,
        error: (error as Error).message.slice(0, 120),
      });
    }
  }

  return { flipped, failed };
}
