import type {
  PaprCloudFeatureId,
  PaprCloudRequirement,
} from "../constants/paprCloudFeatures.js";
import { getPaprCloudFeature } from "../constants/paprCloudFeatures.js";
import { hasActivePaprSubscription } from "./paprPlanLimits.js";

export type PaprCloudLockReason =
  | "login_required"
  | "subscription_required"
  | "cloud_sync_required"
  | "memory_paused";

export type PaprCloudLockAction =
  | "open_login"
  | "open_plan"
  | "enable_cloud_sync";

export interface PaprCloudAccessContext {
  isLoggedIn: boolean;
  subscriptionActive: boolean;
  cloudSyncEnabled: boolean;
  /** True when subscription exists but memory API is blocked (limits, billing mismatch). */
  memoryPaused: boolean;
}

export interface PaprCloudFeatureAccessResult {
  allowed: boolean;
  featureId: PaprCloudFeatureId;
  lockReason?: PaprCloudLockReason;
  lockAction?: PaprCloudLockAction;
  title: string;
  message: string;
  localFallback?: string;
}

function subscriptionActiveFromStatus(
  subscriptionStatus?: string | null,
): boolean {
  return hasActivePaprSubscription({ subscriptionStatus });
}

export function buildPaprCloudAccessContext(input: {
  isLoggedIn: boolean;
  subscriptionStatus?: string | null;
  cloudSyncEnabled: boolean;
  memoryPaused?: boolean;
}): PaprCloudAccessContext {
  return {
    isLoggedIn: input.isLoggedIn,
    subscriptionActive: subscriptionActiveFromStatus(input.subscriptionStatus),
    cloudSyncEnabled: input.cloudSyncEnabled,
    memoryPaused: input.memoryPaused === true,
  };
}

function lockCopy(
  reason: PaprCloudLockReason,
  featureLabel: string,
): { title: string; message: string; action: PaprCloudLockAction } {
  switch (reason) {
    case "login_required":
      return {
        title: "Sign in to Papr",
        message: `${featureLabel} requires a Papr account. Sign in under Settings to continue.`,
        action: "open_login",
      };
    case "subscription_required":
      return {
        title: "Papr Cloud subscription required",
        message: `${featureLabel} is part of Papr Cloud. Choose a plan to enable it.`,
        action: "open_plan",
      };
    case "cloud_sync_required":
      return {
        title: "Turn on Cloud Sync",
        message: `${featureLabel} needs Cloud Sync enabled in Settings.`,
        action: "enable_cloud_sync",
      };
    case "memory_paused":
      return {
        title: "Papr Cloud paused",
        message:
          "Subscription or plan limits block Papr Cloud. Sync, publish, memory, and Papr-routed models stay off until billing is fixed.",
        action: "open_plan",
      };
  }
}

function requirementMet(
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

function firstMissingRequirement(
  requirements: readonly PaprCloudRequirement[],
  ctx: PaprCloudAccessContext,
): PaprCloudLockReason | null {
  if (!ctx.isLoggedIn && requirements.includes("login")) {
    return "login_required";
  }
  if (
    ctx.isLoggedIn &&
    ctx.memoryPaused &&
    requirements.includes("subscription")
  ) {
    return "memory_paused";
  }
  if (!ctx.subscriptionActive && requirements.includes("subscription")) {
    return "subscription_required";
  }
  if (!ctx.cloudSyncEnabled && requirements.includes("cloud_sync_enabled")) {
    return "cloud_sync_required";
  }
  return null;
}

export function resolvePaprCloudFeatureAccess(
  featureId: PaprCloudFeatureId,
  ctx: PaprCloudAccessContext,
): PaprCloudFeatureAccessResult {
  const feature = getPaprCloudFeature(featureId);

  if (feature.requires.every((req) => requirementMet(req, ctx))) {
    return {
      allowed: true,
      featureId,
      title: feature.label,
      message: feature.description,
      localFallback: feature.localFallback,
    };
  }

  const lockReason =
    firstMissingRequirement(feature.requires, ctx) ?? "subscription_required";
  const copy = lockCopy(lockReason, feature.label);

  return {
    allowed: false,
    featureId,
    lockReason,
    lockAction: copy.action,
    title: copy.title,
    message: copy.message,
    localFallback: feature.localFallback,
  };
}
