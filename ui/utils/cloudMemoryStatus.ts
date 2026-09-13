import type { PaprPlanSummary } from "../../src/core/types/paprBilling";
import {
  hasActivePaprSubscription,
  storageLimitToBytes,
} from "../../src/core/utils/paprPlanLimits";
import type { PaprQuotaKind } from "../stores/paprQuotaStore";
import { ensureSettingsTab } from "../lib/ensureSettingsTab";

export type CloudMemoryStatusLevel = "warning" | "paused";

export interface CloudMemoryStatus {
  level: CloudMemoryStatusLevel;
  label: string;
  detail: string;
}

function isOverLimit(current: number, limit: number): boolean {
  return limit > 0 && current >= limit;
}

function hasHardLimitBlock(summary: PaprPlanSummary): boolean {
  const { warnings } = summary;
  return (
    warnings.operationsExceeded ||
    warnings.memoriesExceeded ||
    warnings.storageExceeded
  );
}

function hasNearLimitWarning(summary: PaprPlanSummary): boolean {
  const { warnings } = summary;
  return (
    warnings.operationsNearLimit ||
    warnings.memoriesNearLimit ||
    warnings.storageNearLimit
  );
}

function hasMeteredOverage(summary: PaprPlanSummary): boolean {
  if (!summary.isMeteredBillingOn) return false;
  const storageBytes = storageLimitToBytes(summary.limits.storageLimit);
  return (
    isOverLimit(summary.usage.miniInteractionCount, summary.limits.miniInteractionLimit) ||
    isOverLimit(summary.usage.memoriesCount, summary.limits.memoriesLimit) ||
    isOverLimit(summary.usage.storageCount, storageBytes)
  );
}

export function planNeedsAttention(summary: PaprPlanSummary): boolean {
  return deriveCloudMemoryStatus(summary) !== null;
}

export function deriveCloudMemoryStatus(
  summary: PaprPlanSummary,
  quotaKind?: PaprQuotaKind | null,
): CloudMemoryStatus | null {
  const subscriptionActive = hasActivePaprSubscription(summary);

  if (quotaKind === "subscription" && subscriptionActive) {
    return {
      level: "paused",
      label: "Papr Cloud sync issue",
      detail: "Local chat works. Sign out and back in to refresh billing.",
    };
  }

  if (!subscriptionActive) {
    const status = summary.subscriptionStatus?.toLowerCase();
    if (status === "past_due" || status === "unpaid") {
      return {
        level: "paused",
        label: "Payment due",
        detail: "Papr Cloud paused. Local chat works.",
      };
    }
    if (status === "canceled") {
      return {
        level: "paused",
        label: "Subscription cancelled",
        detail: "Papr Cloud paused. Local chat works.",
      };
    }
    return {
      level: "paused",
      label: "Papr Cloud paused",
      detail: "Local chat works. Fix plan in Settings.",
    };
  }

  if (hasHardLimitBlock(summary)) {
    return {
      level: "paused",
      label: "Plan limit reached",
      detail: "Papr Cloud paused. Local chat works.",
    };
  }

  if (hasMeteredOverage(summary)) {
    return {
      level: "warning",
      label: "Over plan limits",
      detail: "Metered billing on. Usage continues on this device.",
    };
  }

  if (hasNearLimitWarning(summary)) {
    return {
      level: "warning",
      label: "Near plan limit",
      detail: "Papr Cloud may pause soon without metered billing.",
    };
  }

  return null;
}

export type PaprLoginStatusDotClass =
  | "papr-section__dot--connected"
  | "papr-section__dot--warning"
  | "papr-section__dot--paused";

export interface PaprLoginStatusLine {
  dotClass: PaprLoginStatusDotClass;
  text: string;
}

export type PaprCloudStatusDotVariant = "connected" | "warning" | "paused";

export function paprCloudStatusDotVariant(
  cloudStatus: CloudMemoryStatus | null,
): PaprCloudStatusDotVariant {
  if (!cloudStatus) return "connected";
  return cloudStatus.level;
}

function formatConnectedSinceLabel(connectedSince?: string | null): string | null {
  if (!connectedSince) return null;
  return new Date(connectedSince).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Profile / account card status — auth is separate from Papr Cloud health. */
export function formatPaprLoginStatusLine(options: {
  connectedSince?: string | null;
  cloudStatus: CloudMemoryStatus | null;
}): PaprLoginStatusLine {
  if (options.cloudStatus) {
    const cloudSuffix =
      options.cloudStatus.level === "paused"
        ? "Papr Cloud paused"
        : options.cloudStatus.label;

    return {
      dotClass:
        options.cloudStatus.level === "paused"
          ? "papr-section__dot--paused"
          : "papr-section__dot--warning",
      text: `Papr logged in · ${cloudSuffix}`,
    };
  }

  const connectedLabel = formatConnectedSinceLabel(options.connectedSince);
  return {
    dotClass: "papr-section__dot--connected",
    text: connectedLabel
      ? `Papr logged in · ${connectedLabel}`
      : "Papr logged in",
  };
}

export { openPaprPlanSettings } from "./paprCloudFeatureUi";
