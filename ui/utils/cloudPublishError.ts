import {
  extractErrorMessage,
  parsePaprQuotaError,
} from "../../src/core/utils/paprQuota";
import { CloudPublishBlockedError } from "./cloudPublishApi";
import {
  usePaprQuotaStore,
  type PaprQuotaBannerState,
} from "../stores/paprQuotaStore";

export interface CloudPublishErrorHandling {
  /** Short label for the publish bar; null when quota banner handles the UX. */
  barMessage: string | null;
  /** Full message for the detail panel. */
  detailMessage: string;
  quotaBannerShown: boolean;
}

/** Short chip / bar label for v2 publish bar — details live in the click-through panel. */
export const PUBLISH_FAILED_CHIP_LABEL = "Failed to publish";

export function handleCloudPublishError(err: unknown): CloudPublishErrorHandling {
  if (err instanceof CloudPublishBlockedError) {
    const detailMessage =
      err.message.trim() ||
      "This app uses desktop-only features. Confirm in the share sheet to publish.";
    return {
      barMessage: null,
      detailMessage,
      quotaBannerShown: false,
    };
  }

  const detailMessage = extractErrorMessage(err).trim() || "Publish failed";
  const quota = parsePaprQuotaError(err, "cloud-publish");

  if (quota) {
    const bannerState: PaprQuotaBannerState = {
      ...quota,
      reportedAt: new Date().toISOString(),
    };
    usePaprQuotaStore.getState().setQuotaStatus(bannerState);
    return {
      barMessage: null,
      detailMessage: `${quota.title} ${quota.detail}`,
      quotaBannerShown: true,
    };
  }

  return {
    barMessage: PUBLISH_FAILED_CHIP_LABEL,
    detailMessage,
    quotaBannerShown: false,
  };
}
