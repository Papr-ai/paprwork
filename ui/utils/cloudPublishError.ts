import {
  extractErrorMessage,
  parsePaprQuotaError,
} from "../../src/core/utils/paprQuota";
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

export function handleCloudPublishError(err: unknown): CloudPublishErrorHandling {
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
    barMessage: summarizePublishError(detailMessage),
    detailMessage,
    quotaBannerShown: false,
  };
}

function summarizePublishError(message: string, maxLen = 72): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1).trimEnd()}…`;
}
