import type {
  PaprCloudFeatureId,
  PaprCloudRequirement,
} from "../../src/core/constants/paprCloudFeatures";
import { getPaprCloudFeature } from "../../src/core/constants/paprCloudFeatures";
import type { PaprPlanSummary } from "../../src/core/types/paprBilling";
import type {
  PaprCloudAccessContext,
  PaprCloudFeatureAccessResult,
  PaprCloudLockAction,
} from "../../src/core/utils/paprCloudFeatureAccess";
import { resolvePaprCloudFeatureAccess } from "../../src/core/utils/paprCloudFeatureAccess";
import type { CloudMemoryStatus } from "./cloudMemoryStatus";
import { openPaprPlanSettings, planNeedsAttention } from "./cloudMemoryStatus";
import { openCloudSyncSettings, openPaprLoginSettings } from "./paprCloudFeatureUi";

const REQUIREMENT_LABELS: Record<PaprCloudRequirement, string> = {
  login: "Sign in to Papr",
  subscription: "Active Papr Cloud plan",
  cloud_sync_enabled: "Cloud Sync enabled",
};

export interface PaprCloudRequirementRow {
  requirement: PaprCloudRequirement;
  label: string;
  met: boolean;
  fixAction: PaprCloudLockAction | null;
  fixLabel: string | null;
}

function isRequirementMet(
  requirement: PaprCloudRequirement,
  ctx: PaprCloudAccessContext,
): boolean {
  switch (requirement) {
    case "login":
      return ctx.isLoggedIn;
    case "subscription":
      return ctx.subscriptionActive && !ctx.memoryPaused;
    case "cloud_sync_enabled":
      return ctx.cloudSyncEnabled;
  }
}

function fixForRequirement(
  requirement: PaprCloudRequirement,
  ctx: PaprCloudAccessContext,
): { action: PaprCloudLockAction; label: string } | null {
  if (isRequirementMet(requirement, ctx)) {
    return null;
  }

  switch (requirement) {
    case "login":
      return { action: "open_login", label: "Sign in" };
    case "subscription":
      return { action: "open_plan", label: "Plan & usage" };
    case "cloud_sync_enabled":
      return { action: "enable_cloud_sync", label: "Cloud Sync settings" };
  }
}

export function buildPaprCloudRequirementRows(
  featureId: PaprCloudFeatureId,
  ctx: PaprCloudAccessContext,
): { rows: PaprCloudRequirementRow[]; access: PaprCloudFeatureAccessResult } {
  const feature = getPaprCloudFeature(featureId);
  const access = resolvePaprCloudFeatureAccess(featureId, ctx);
  const rows = feature.requires.map((requirement) => {
    const fix = fixForRequirement(requirement, ctx);
    return {
      requirement,
      label: REQUIREMENT_LABELS[requirement],
      met: isRequirementMet(requirement, ctx),
      fixAction: fix?.action ?? null,
      fixLabel: fix?.label ?? null,
    };
  });

  return { rows, access };
}

/** Show the requirements panel only when something needs user attention. */
export function paprCloudPanelNeedsAttention(input: {
  context: PaprCloudAccessContext;
  accessAllowed: boolean;
  cloudStatus: CloudMemoryStatus | null;
  planSummary: PaprPlanSummary | null;
}): boolean {
  if (!input.context.isLoggedIn) {
    return true;
  }
  if (!input.accessAllowed) {
    return true;
  }
  if (!input.context.cloudSyncEnabled) {
    return true;
  }
  if (input.cloudStatus !== null) {
    return true;
  }
  if (input.planSummary !== null && planNeedsAttention(input.planSummary)) {
    return true;
  }
  return false;
}

export function runPaprCloudFixAction(action: PaprCloudLockAction): void {
  switch (action) {
    case "open_login":
      openPaprLoginSettings();
      break;
    case "open_plan":
      openPaprPlanSettings();
      break;
    case "enable_cloud_sync":
      openCloudSyncSettings();
      break;
  }
}
