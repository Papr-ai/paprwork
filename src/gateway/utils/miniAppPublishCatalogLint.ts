/**
 * validate_app warnings for cloud publish credential catalog vs linked jobs.
 */

import type { ValidationIssue } from "../services/AppService.js";
import {
  readLinkedJobKeysMissingFromSavedRequirements,
  type LinkedJobCatalogKeyRef,
} from "../services/cloudAppRequirements.js";
import { getPaprRoot } from "../../core/utils/paprRoot.js";

function formatCatalogGapMessage(
  appId: string,
  ref: LinkedJobCatalogKeyRef,
): string {
  const via =
    ref.source === "requiredKeys"
      ? "job.json requiredKeys"
      : "${KEY_NAME} in the job command";
  return (
    `Linked job ${ref.jobId} uses integration key ${ref.keyName} (${via}). ` +
    `It is missing from apps/${appId}/requirements.json — the cloud vault catalog for apps.papr.ai. ` +
    `Job runtime still injects requiredKeys in the sandbox; visitors need the catalog entry for vault resolve. ` +
    `Fix: run Sync now on the app (auto-syncs detected keys), republish, or add the key in the publish credentials panel. ` +
    `Do not use papr-cloud-dependencies.json for API keys (that file is cross-app/database install deps only).`
  );
}

export function checkLinkedJobPublishCatalogGaps(
  paprDir: string,
  appId: string,
): ValidationIssue[] {
  const gaps = readLinkedJobKeysMissingFromSavedRequirements(paprDir, appId);
  return gaps.map((ref) => ({
    file: `Jobs/${ref.jobId}/job.json`,
    severity: "warning" as const,
    rule: "publish-catalog-linked-job-key",
    message: formatCatalogGapMessage(appId, ref),
  }));
}

/** Uses active Papr workspace root. */
export function checkLinkedJobPublishCatalogGapsForApp(
  appId: string,
): ValidationIssue[] {
  return checkLinkedJobPublishCatalogGaps(getPaprRoot(), appId);
}
