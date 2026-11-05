/**
 * Plan summary for an org billed in credits (memory /v1/credits/usage returned an
 * allowance). Credits orgs have no legacy Stripe subscription, operation or memory
 * limits, so those fields are neutral and the Billing screen reads `credits`.
 */
import type { PaprCreditsSummary, PaprPlanSummary } from "../types/paprBilling.js";
import type { BuildersView, CreditUsageView } from "./paprCreditSeats.js";

const PLAN_NAMES: Record<string, string> = {
  local: "Local",
  cloud: "Cloud",
  cloud_plus: "Cloud Max 5x",
  cloud_max: "Cloud Max 20x",
};

export function creditsPlanName(plan: string): string {
  return PLAN_NAMES[plan] ?? plan;
}

/** null = not a credits org: build the legacy summary. */
export function creditsSummaryFromUsage(view: CreditUsageView | null | undefined): PaprCreditsSummary | null {
  const you = view?.allowance;
  if (!view || !you) return null;
  const org = view.org;
  return {
    plan: you.plan || org?.plan || "local",
    period: view.period,
    you: {
      grant: you.grant ?? 0,
      used: you.used ?? 0,
      state: you.state,
      reason: you.reason ?? null,
      seat: you.seat !== false,
      memberCap: you.memberCap,
      requests: you.requests ?? [],
    },
    org: org ? { grant: org.grant ?? 0, used: org.used ?? 0, state: org.state, seats: org.seats ?? 1 } : null,
    topupBalanceUsd: you.topupBalanceUsd ?? null,
  };
}

/**
 * This user's org role from memory's /builders view (owner/admin only can read it).
 * Used when the Parse workspace member list is unavailable (e.g. Forbidden), so an org
 * owner isn't shown the member view. null = no owner/admin role found.
 */
export function creditsRoleFromBuilders(
  view: Pick<BuildersView, "builderUsage" | "memberUsage"> | null | undefined,
  userId: string,
): "owner" | "admin" | null {
  if (!view) return null;
  const row = [...(view.builderUsage ?? []), ...(view.memberUsage ?? [])].find((r) => r.userId === userId);
  if (row?.roles.includes("owner")) return "owner";
  // /builders answered, so memory already treats this user as an owner or admin.
  return "admin";
}

export function buildCreditsPlanSummary(input: {
  credits: PaprCreditsSummary;
  isWorkspaceOwner: boolean;
  isWorkspaceAdmin: boolean;
  stripeCustomerId?: string;
}): PaprPlanSummary {
  const { credits } = input;
  const name = creditsPlanName(credits.plan);
  return {
    planName: name,
    // Not a legacy tier; "developer" keeps the plan cards visible for upgrades.
    planTier: "developer",
    planFeatures: credits.plan === "local" ? "Free, runs on your machine" : `${name} plan, billed in credits`,
    // Credits orgs are always active: Local is free, paid plans bill through credits checkout.
    subscriptionStatus: "active",
    trialEnd: null,
    isTrialPeriod: false,
    cancelAtPeriodEnd: false,
    isWorkspaceOwner: input.isWorkspaceOwner,
    isWorkspaceAdmin: input.isWorkspaceAdmin,
    canManageBilling: input.isWorkspaceOwner,
    stripeCustomerId: input.stripeCustomerId,
    isMeteredBillingOn: false,
    usage: { memoriesCount: 0, storageCount: 0, memoryStorageCount: 0, appStorageCount: 0, miniInteractionCount: 0 },
    limits: { memoriesLimit: 0, miniInteractionLimit: 0, premiumInteractionLimit: 0, storageLimit: "0", price: 0, seats: credits.org?.seats ?? 1 },
    warnings: {
      memoriesExceeded: false, storageExceeded: false, operationsExceeded: false,
      memoriesNearLimit: false, storageNearLimit: false, operationsNearLimit: false,
    },
    credits,
  };
}
