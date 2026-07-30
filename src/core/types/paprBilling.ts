export type PaprSubscriptionTier =
  | "developer"
  | "starter"
  | "growth"
  | "intelligence";

export type PaprCheckoutTier = "starter" | "growth";
export type PaprBillingCycle = "monthly" | "yearly";

export interface PaprPlanLimits {
  memoriesLimit: number;
  miniInteractionLimit: number;
  premiumInteractionLimit: number;
  storageLimit: string;
  price: number;
  seats: number;
}

export interface PaprUsageSnapshot {
  memoriesCount: number;
  storageCount: number;
  miniInteractionCount: number;
}

export interface PaprPlanWarnings {
  memoriesExceeded: boolean;
  storageExceeded: boolean;
  operationsExceeded: boolean;
  memoriesNearLimit: boolean;
  storageNearLimit: boolean;
  operationsNearLimit: boolean;
}

export interface PaprStripeSubscriptionInfo {
  status?: string;
  planNickname?: string | null;
  planId?: string | null;
  trialEnd?: number | null;
  cancelAtPeriodEnd?: boolean;
  isActive?: boolean;
}

export interface PaprPlanSummary {
  planName: string;
  planTier: PaprSubscriptionTier;
  planFeatures: string;
  subscriptionStatus?: string;
  trialEnd?: string | null;
  isTrialPeriod: boolean;
  cancelAtPeriodEnd?: boolean;
  isWorkspaceOwner: boolean;
  isWorkspaceAdmin: boolean;
  canManageBilling: boolean;
  stripeCustomerId?: string;
  subscriptionObjectId?: string;
  isMeteredBillingOn: boolean;
  usage: PaprUsageSnapshot;
  limits: PaprPlanLimits;
  warnings: PaprPlanWarnings;
}

export const PAPR_CHECKOUT_PRICE_IDS: Record<
  PaprCheckoutTier,
  Record<PaprBillingCycle, string>
> = {
  starter: {
    monthly: "price_1RaTTDLvxLkj9c6vO6NfLFem",
    yearly: "price_1RaTUwLvxLkj9c6vMqQRpElV",
  },
  growth: {
    monthly: "price_1Rac1GLvxLkj9c6vfXC5NlQc",
    yearly: "price_1Rac1GLvxLkj9c6v7rV5Vf5D",
  },
};
