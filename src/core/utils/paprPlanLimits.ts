import type {
  PaprPlanLimits,
  PaprPlanWarnings,
  PaprSubscriptionTier,
  PaprUsageSnapshot,
} from "../types/paprBilling.js";

export const PAPR_PLAN_LIMITS: Record<PaprSubscriptionTier, PaprPlanLimits> = {
  developer: {
    memoriesLimit: 2500,
    miniInteractionLimit: 1000,
    premiumInteractionLimit: 0,
    storageLimit: "1GB",
    price: 0,
    seats: 999,
  },
  starter: {
    memoriesLimit: 50000,
    miniInteractionLimit: 20000,
    premiumInteractionLimit: 0,
    storageLimit: "10GB",
    price: 100,
    seats: 999,
  },
  growth: {
    memoriesLimit: 250000,
    miniInteractionLimit: 100000,
    premiumInteractionLimit: 0,
    storageLimit: "100GB",
    price: 500,
    seats: 999,
  },
  intelligence: {
    memoriesLimit: 500000,
    miniInteractionLimit: 500000,
    premiumInteractionLimit: 0,
    storageLimit: "500GB",
    price: 0,
    seats: 999,
  },
};

export function normalizePlanTier(rawTier?: string | null): PaprSubscriptionTier {
  const normalized = (rawTier ?? "").toLowerCase().replace(/_/g, " ");

  if (normalized.includes("memory intelligence") || normalized.includes("intelligence")) {
    return "intelligence";
  }
  if (normalized.includes("enterprise")) {
    return "intelligence";
  }
  if (normalized.includes("business plus") || normalized.includes("businessplus")) {
    return "growth";
  }
  if (normalized.includes("growth")) {
    return "growth";
  }
  if (normalized.includes("pro")) {
    return "growth";
  }
  if (normalized.includes("starter")) {
    return "starter";
  }
  if (normalized.includes("plus")) {
    return "starter";
  }
  if (normalized.includes("developer") || normalized.includes("free")) {
    return "developer";
  }
  return "developer";
}

export function planTierRank(tier: PaprSubscriptionTier): number {
  switch (tier) {
    case "intelligence":
      return 4;
    case "growth":
      return 3;
    case "starter":
      return 2;
    case "developer":
      return 1;
    default:
      return 0;
  }
}

export function pickHighestPlanTier(
  labels: Array<string | null | undefined>,
): PaprSubscriptionTier {
  let best: PaprSubscriptionTier = "developer";
  let bestRank = 0;
  for (const label of labels) {
    if (!label?.trim()) continue;
    const tier = normalizePlanTier(label);
    const rank = planTierRank(tier);
    if (rank > bestRank) {
      bestRank = rank;
      best = tier;
    }
  }
  return best;
}

export function getPlanLimitsForTier(tier?: string | null): PaprPlanLimits {
  return PAPR_PLAN_LIMITS[normalizePlanTier(tier)];
}

export function planFeaturesForTier(tier: PaprSubscriptionTier): string {
  switch (tier) {
    case "intelligence":
      return "500K monthly operations, 500GB storage, 500,000 memories";
    case "starter":
      return "20K monthly operations, 10GB storage, 50,000 memories";
    case "growth":
      return "100K monthly operations, 100GB storage, 250,000 memories";
    default:
      return "1K monthly operations, 1GB storage, 2,500 memories";
  }
}

export function planDisplayName(tier: PaprSubscriptionTier): string {
  switch (tier) {
    case "intelligence":
      return "Memory Intelligence";
    case "starter":
      return "Starter";
    case "growth":
      return "Growth";
    default:
      return "Developer";
  }
}

export function storageLimitToBytes(storageLimit: string): number {
  const match = storageLimit.match(/(\d+)(MB|GB)/);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid storage size format: ${storageLimit}`);
  }
  const value = Number.parseInt(match[1], 10);
  if (match[2] === "GB") {
    return value * 1024 * 1024 * 1024;
  }
  return value * 1024 * 1024;
}

export function formatStorageUsage(bytes: number, limitLabel: string): string {
  if (bytes < 1024) return `${bytes} B / ${limitLabel}`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB / ${limitLabel}`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB / ${limitLabel}`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB / ${limitLabel}`;
}

function isNearLimit(current: number, limit: number, threshold = 0.9): boolean {
  if (limit <= 0) return false;
  return current / limit >= threshold;
}

function hasExceededLimit(current: number, limit: number): boolean {
  return current >= limit;
}

export function buildPlanWarnings(
  usage: PaprUsageSnapshot,
  limits: PaprPlanLimits,
  options?: { isMeteredBillingOn?: boolean },
): PaprPlanWarnings {
  const storageLimitBytes = storageLimitToBytes(limits.storageLimit);
  const memoriesExceeded = hasExceededLimit(usage.memoriesCount, limits.memoriesLimit);
  const storageExceeded = hasExceededLimit(usage.storageCount, storageLimitBytes);
  const operationsExceeded = hasExceededLimit(
    usage.miniInteractionCount,
    limits.miniInteractionLimit,
  );

  if (options?.isMeteredBillingOn) {
    return {
      memoriesExceeded: false,
      storageExceeded: false,
      operationsExceeded: false,
      memoriesNearLimit: isNearLimit(usage.memoriesCount, limits.memoriesLimit),
      storageNearLimit: isNearLimit(usage.storageCount, storageLimitBytes),
      operationsNearLimit: isNearLimit(
        usage.miniInteractionCount,
        limits.miniInteractionLimit,
      ),
    };
  }

  return {
    memoriesExceeded,
    storageExceeded,
    operationsExceeded,
    memoriesNearLimit: isNearLimit(usage.memoriesCount, limits.memoriesLimit),
    storageNearLimit: isNearLimit(usage.storageCount, storageLimitBytes),
    operationsNearLimit: isNearLimit(
      usage.miniInteractionCount,
      limits.miniInteractionLimit,
    ),
  };
}

/** Resolve billing tier from Stripe nickname (matches dashboard usageChecks). */
export function resolvePlanTierFromNickname(
  planNickname?: string | null,
): PaprSubscriptionTier {
  return normalizePlanTier(planNickname ?? undefined);
}

/**
 * Match dashboard UserUsage.getCurrentPlanTier — when Stripe reports an active
 * paid subscription, trust the plan nickname before Parse tier fallbacks.
 */
export function resolvePlanTierForBilling(input: {
  stripeStatus?: string | null;
  stripePlanNickname?: string | null;
  fallbackLabels?: Array<string | null | undefined>;
}): PaprSubscriptionTier {
  if (input.stripeStatus === "active" && input.stripePlanNickname?.trim()) {
    return resolvePlanTierFromNickname(input.stripePlanNickname);
  }
  return resolvePlanTierFromSources({
    labels: input.fallbackLabels ?? [],
  });
}

/** Never treat subscription lifecycle status (e.g. "active") as a plan tier. */
export function resolvePlanTierFromSources(input: {
  labels: Array<string | null | undefined>;
}): PaprSubscriptionTier {
  const filtered = input.labels.filter(
    (label) => label?.trim() && !isSubscriptionLifecycleStatus(label),
  );
  return pickHighestPlanTier(filtered);
}

function isSubscriptionLifecycleStatus(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return (
    normalized === "active" ||
    normalized === "trialing" ||
    normalized === "past_due" ||
    normalized === "canceled" ||
    normalized === "unpaid" ||
    normalized === "incomplete"
  );
}

/** Same gate Settings uses before enabling metered billing or treating Stripe as authoritative. */
export function hasActivePaprSubscription(input: {
  subscriptionStatus?: string | null;
}): boolean {
  const status = input.subscriptionStatus?.trim().toLowerCase();
  return status === "active" || status === "trialing";
}

export function usageBarPercent(current: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min((current / limit) * 100, 100);
}
