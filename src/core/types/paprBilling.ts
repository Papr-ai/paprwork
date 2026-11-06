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
  /**
   * Total storage against the plan limit: Papr Memory plus App Files.
   * Both draw on one allowance, so this is what the storage bar shows.
   */
  storageCount: number;
  /** Memory-only bytes, for the breakdown under the bar. */
  memoryStorageCount: number;
  /** App Files bytes (recordings, uploads), for the breakdown. */
  appStorageCount: number;
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
  /** Stripe default payment method on file (from usage/metrics subscription). */
  hasPaymentMethod?: boolean;
  subscriptionObjectId?: string;
  isMeteredBillingOn: boolean;
  usage: PaprUsageSnapshot;
  limits: PaprPlanLimits;
  warnings: PaprPlanWarnings;
  /** Set when the org is billed in credits: the legacy usage/limits fields are unused. */
  credits?: PaprCreditsSummary;
}

export interface PaprCreditsSummary {
  /** Credits plan key: local | cloud | cloud_plus | cloud_max. */
  plan: string;
  period: string;
  /** This person's allowance. */
  you: { grant: number; used: number; state: string; reason?: string | null; seat: boolean; memberCap?: number; requests?: string[] };
  /** Whole org, all seats. */
  org: { grant: number; used: number; state: string; seats: number } | null;
  /** Prepaid top-up balance in USD, when known. */
  topupBalanceUsd?: number | null;
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
