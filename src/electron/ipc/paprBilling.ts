/**
 * Papr plan, usage, and billing IPC — mirrors dashboard org-owner billing flows.
 */

import { ipcMain, shell } from "electron";
import type { SettingsStorage } from "../../core/storage/index.js";
import type {
  PaprBillingCycle,
  PaprCheckoutTier,
  PaprPlanSummary,
  PaprStripeSubscriptionInfo,
  PaprUsageSnapshot,
} from "../../core/types/paprBilling.js";
import { PAPR_CHECKOUT_PRICE_IDS } from "../../core/types/paprBilling.js";
import {
  buildPlanWarnings,
  getPlanLimitsForTier,
  planDisplayName,
  planFeaturesForTier,
  resolvePlanTierForBilling,
} from "../../core/utils/paprPlanLimits.js";
import { fetchWorkspaceMembers } from "../../core/utils/paprWorkspaceTeam.js";
import { PAPR_USAGE_URL } from "../../core/utils/paprQuota.js";

type GraphQLRunner = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

interface BillingServices {
  settingsStorage: SettingsStorage;
  runGraphQL: GraphQLRunner;
}

const PAPR_PLATFORM_URL = (
  process.env.PAPR_PLATFORM_URL || "https://dashboard.papr.ai"
).replace(/\/$/, "");

interface UsageMetricsResponse {
  organization?: {
    memoriesCount?: number;
    storageCount?: number;
  };
  currentMonth?: {
    totalInteractions?: number;
  };
  subscription?: {
    status?: string;
    planNickname?: string | null;
    planId?: string | null;
    trialEnd?: number | null;
    cancelAtPeriodEnd?: boolean;
    isActive?: boolean;
    parseTier?: string | null;
    isMeteredBillingOn?: boolean;
  } | null;
}

interface UsageMetricsResult {
  usage: PaprUsageSnapshot;
  subscriptionFromMetrics: PaprStripeSubscriptionInfo | null;
  parseTierFromMetrics?: string | null;
  isMeteredBillingOnFromMetrics?: boolean;
}

/** Parse `workspace.subscription` Object scalar from Parse GraphQL. */
interface WorkspaceSubscriptionRecord {
  objectId?: string;
  tier?: string;
  stripeCustomerId?: string;
  status?: string;
  trialEnd?: string | null;
  isMeteredBillingOn?: boolean;
  productName?: string;
  planName?: string;
  plan?: {
    nickname?: string;
    name?: string;
  };
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function parseWorkspaceSubscription(
  value: unknown,
): WorkspaceSubscriptionRecord | undefined {
  if (typeof value === "string") {
    try {
      return parseWorkspaceSubscription(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const plan =
    record.plan && typeof record.plan === "object" && !Array.isArray(record.plan)
      ? (record.plan as Record<string, unknown>)
      : undefined;

  return {
    objectId: readStringField(record, "objectId"),
    tier: readStringField(record, "tier"),
    stripeCustomerId: readStringField(record, "stripeCustomerId"),
    status: readStringField(record, "status"),
    trialEnd:
      typeof record.trialEnd === "string" || record.trialEnd === null
        ? record.trialEnd
        : undefined,
    isMeteredBillingOn:
      typeof record.isMeteredBillingOn === "boolean"
        ? record.isMeteredBillingOn
        : undefined,
    productName: readStringField(record, "productName"),
    planName: readStringField(record, "planName"),
    plan: plan
      ? {
          nickname: readStringField(plan, "nickname"),
          name: readStringField(plan, "name"),
        }
      : undefined,
  };
}

const GET_PARSE_SUBSCRIPTIONS = `
  query GetParseSubscriptions($stripeCustomerId: String!) {
    subscriptions(where: { stripeCustomerId: { equalTo: $stripeCustomerId } }) {
      edges {
        node
      }
    }
  }
`;

function parseParseSubscriptionNode(node: unknown): WorkspaceSubscriptionRecord | undefined {
  if (!node) return undefined;
  if (typeof node === "string") {
    try {
      return parseWorkspaceSubscription(JSON.parse(node));
    } catch {
      return undefined;
    }
  }
  if (typeof node === "object" && !Array.isArray(node)) {
    return parseWorkspaceSubscription(node);
  }
  return undefined;
}

async function fetchParseSubscriptionLabels(
  runGraphQL: GraphQLRunner,
  stripeCustomerId: string,
): Promise<string[]> {
  try {
    const data = await runGraphQL(GET_PARSE_SUBSCRIPTIONS, { stripeCustomerId });
    const edges = (data.subscriptions as { edges?: Array<{ node?: unknown }> } | undefined)
      ?.edges;
    const labels: string[] = [];
    for (const edge of edges ?? []) {
      const parsed = parseParseSubscriptionNode(edge.node);
      if (!parsed) continue;
      if (parsed.tier) labels.push(parsed.tier);
      if (parsed.productName) labels.push(parsed.productName);
      if (parsed.planName) labels.push(parsed.planName);
      if (parsed.plan?.nickname) labels.push(parsed.plan.nickname);
      if (parsed.plan?.name) labels.push(parsed.plan.name);
    }
    return labels;
  } catch (error) {
    console.warn("[PaprBilling] Parse subscription lookup failed:", error);
    return [];
  }
}

const GET_WORKSPACE_BILLING = `
  query GetWorkspaceBilling($workspaceId: ID!) {
    workSpace(id: $workspaceId) {
      objectId
      workspace_name
      subscription
      organization {
        objectId
        name
        plan_tier
      }
    }
  }
`;

const GET_ORGANIZATION_BILLING = `
  query GetOrganizationBilling($organizationId: ID!) {
    organization(id: $organizationId) {
      objectId
      name
      plan_tier
      workspace {
        objectId
        subscription
      }
    }
  }
`;

const UPDATE_SUBSCRIPTION_METERED_BILLING = `
  mutation UpdateSubscription($input: UpdateSubscriptionInput!) {
    updateSubscription(input: $input) {
      subscription
    }
  }
`;

function requireLoggedInProfile(settingsStorage: SettingsStorage) {
  const profile = settingsStorage.getPaprProfile();
  if (!profile?.sessionToken || !profile.userId) {
    throw new Error("Connect your Papr account in Settings to manage billing.");
  }
  if (!profile.workspaceId || !profile.organizationId) {
    throw new Error("Workspace context is missing. Switch organization and try again.");
  }
  return profile;
}

function persistPlanSummaryToProfile(
  settingsStorage: SettingsStorage,
  summary: PaprPlanSummary,
): void {
  const profile = settingsStorage.getPaprProfile();
  if (!profile) {
    return;
  }
  const nextProfile = { ...profile, planName: summary.planName };
  if (summary.subscriptionStatus !== profile.subscriptionStatus) {
    nextProfile.subscriptionStatus = summary.subscriptionStatus;
  }
  if (
    nextProfile.planName !== profile.planName ||
    nextProfile.subscriptionStatus !== profile.subscriptionStatus
  ) {
    settingsStorage.setPaprProfile(nextProfile);
  }
}

interface StripeSubscriptionApiResponse {
  subscription?: PaprStripeSubscriptionInfo | null;
  error?: string;
}

async function fetchStripeSubscription(
  sessionToken: string,
  workspaceId: string,
): Promise<PaprStripeSubscriptionInfo | null> {
  const url = new URL(`${PAPR_PLATFORM_URL}/api/v1/billing/subscription`);
  url.searchParams.set("workspaceId", workspaceId);

  const response = await fetch(url.toString(), {
    headers: {
      "X-Parse-Session-Token": sessionToken,
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    console.warn(
      "[PaprBilling] Stripe subscription lookup failed:",
      body.error || response.status,
    );
    return null;
  }

  const data = (await response.json()) as StripeSubscriptionApiResponse;
  return data.subscription ?? null;
}

function formatStripeTrialEnd(trialEnd?: number | null): string | null {
  if (!trialEnd) return null;
  return new Date(trialEnd * 1000).toISOString();
}

async function fetchUsageMetrics(
  sessionToken: string,
  workspaceId: string,
  organizationId: string,
): Promise<UsageMetricsResult> {
  const url = new URL(`${PAPR_PLATFORM_URL}/api/v1/usage/metrics`);
  url.searchParams.set("workspaceId", workspaceId);
  url.searchParams.set("organizationId", organizationId);

  const response = await fetch(url.toString(), {
    headers: {
      "X-Parse-Session-Token": sessionToken,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to load usage (${response.status})`);
  }

  const metrics = (await response.json()) as UsageMetricsResponse;
  const subscriptionFromMetrics = metrics.subscription
    ? {
        status: metrics.subscription.status,
        planNickname: metrics.subscription.planNickname ?? null,
        planId: metrics.subscription.planId ?? null,
        trialEnd: metrics.subscription.trialEnd ?? null,
        cancelAtPeriodEnd: metrics.subscription.cancelAtPeriodEnd ?? false,
        isActive: metrics.subscription.isActive ?? false,
      }
    : null;

  return {
    usage: {
      memoriesCount: metrics.organization?.memoriesCount ?? 0,
      storageCount: metrics.organization?.storageCount ?? 0,
      miniInteractionCount: metrics.currentMonth?.totalInteractions ?? 0,
    },
    subscriptionFromMetrics,
    parseTierFromMetrics: metrics.subscription?.parseTier ?? null,
    isMeteredBillingOnFromMetrics: metrics.subscription?.isMeteredBillingOn,
  };
}

async function resolveWorkspaceRole(
  sessionToken: string,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const members = await fetchWorkspaceMembers(sessionToken, workspaceId);
  const self = members.find((member) => member.user.objectId === userId);
  return self?.user.role ?? "member";
}

/**
 * Short-lived cache for the read-only plan summary.
 *
 * Every profile load asks for this, and building it costs two Parse queries plus
 * two dashboard.papr.ai calls (Stripe subscription + usage metrics). Plans do not
 * change second to second, so a brief cache removes almost all of that traffic
 * without the UI ever looking stale. Billing mutations invalidate it explicitly.
 */
const PLAN_SUMMARY_TTL_MS = 60_000;

let planSummaryCache:
  | { key: string; expiresAt: number; summary: PaprPlanSummary }
  | null = null;
let planSummaryInFlight: { key: string; promise: Promise<PaprPlanSummary> } | null =
  null;

function invalidatePlanSummaryCache(): void {
  planSummaryCache = null;
}

/** Plan summary for read paths: cached, and concurrent callers share one build. */
async function getPlanSummaryCached(
  services: BillingServices,
): Promise<PaprPlanSummary> {
  const profile = requireLoggedInProfile(services.settingsStorage);
  const key = `${profile.workspaceId}:${profile.organizationId}`;

  if (planSummaryCache?.key === key && planSummaryCache.expiresAt > Date.now()) {
    return planSummaryCache.summary;
  }
  if (planSummaryInFlight?.key === key) {
    return planSummaryInFlight.promise;
  }

  const promise = buildPlanSummary(services)
    .then((summary) => {
      planSummaryCache = {
        key,
        expiresAt: Date.now() + PLAN_SUMMARY_TTL_MS,
        summary,
      };
      return summary;
    })
    .finally(() => {
      planSummaryInFlight = null;
    });

  planSummaryInFlight = { key, promise };
  return promise;
}

async function buildPlanSummary(services: BillingServices): Promise<PaprPlanSummary> {
  const profile = requireLoggedInProfile(services.settingsStorage);

  // Paprwork profile is the source of truth for active workspace/namespace (desktop may
  // differ from Parse isSelectedWorkspaceFollower when the user switches namespace locally).
  const workspaceId = profile.workspaceId!;
  const organizationId = profile.organizationId!;

  const [workspaceBillingData, organizationBillingData] = await Promise.all([
    services.runGraphQL(GET_WORKSPACE_BILLING, { workspaceId }),
    services.runGraphQL(GET_ORGANIZATION_BILLING, { organizationId }),
  ]);

  const workspaceRecord = workspaceBillingData.workSpace as
    | {
        objectId?: string;
        subscription?: unknown;
        organization?: {
          objectId?: string;
          name?: string;
          plan_tier?: string;
        };
      }
    | undefined;

  const organizationRecord = organizationBillingData.organization as
    | {
        objectId?: string;
        name?: string;
        plan_tier?: string;
        workspace?: {
          objectId?: string;
          subscription?: unknown;
        };
      }
    | undefined;

  const workspaceSubscription = parseWorkspaceSubscription(workspaceRecord?.subscription);
  const orgLinkedSubscription = parseWorkspaceSubscription(
    organizationRecord?.workspace?.subscription,
  );
  const subscription = workspaceSubscription ?? orgLinkedSubscription;

  const activeOrgPlanTier = organizationRecord?.plan_tier;
  const workspaceOrgPlanTier = workspaceRecord?.organization?.plan_tier;

  const stripeCustomerId = subscription?.stripeCustomerId;

  console.log("[PaprBilling] Active billing context:", {
    workspaceId,
    organizationId,
    activeOrgPlanTier,
    workspaceOrgPlanTier,
    stripeCustomerId: stripeCustomerId ? `${stripeCustomerId.slice(0, 12)}…` : null,
  });

  const usageMetricsResult = await fetchUsageMetrics(
    profile.sessionToken!,
    workspaceId,
    organizationId,
  );

  let stripeSubscription = await fetchStripeSubscription(
    profile.sessionToken!,
    workspaceId,
  );

  // Fallback: usage/metrics includes Stripe plan (same source as dashboard billing tab)
  if (
    (!stripeSubscription || !stripeSubscription.planNickname) &&
    usageMetricsResult.subscriptionFromMetrics
  ) {
    stripeSubscription = {
      ...usageMetricsResult.subscriptionFromMetrics,
      ...stripeSubscription,
      planNickname:
        stripeSubscription?.planNickname ??
        usageMetricsResult.subscriptionFromMetrics.planNickname,
      status:
        stripeSubscription?.status ?? usageMetricsResult.subscriptionFromMetrics.status,
      planId:
        stripeSubscription?.planId ?? usageMetricsResult.subscriptionFromMetrics.planId,
      trialEnd:
        stripeSubscription?.trialEnd ??
        usageMetricsResult.subscriptionFromMetrics.trialEnd,
      cancelAtPeriodEnd:
        stripeSubscription?.cancelAtPeriodEnd ??
        usageMetricsResult.subscriptionFromMetrics.cancelAtPeriodEnd,
      isActive:
        stripeSubscription?.isActive ??
        usageMetricsResult.subscriptionFromMetrics.isActive,
    };
    console.log(
      "[PaprBilling] Using subscription from usage/metrics:",
      stripeSubscription.planNickname,
    );
  }

  const parseSubscriptionLabels = stripeCustomerId
    ? await fetchParseSubscriptionLabels(services.runGraphQL, stripeCustomerId)
    : [];

  const isTrialPeriod = stripeSubscription?.status === "trialing";
  const planTier = resolvePlanTierForBilling({
    stripeStatus: stripeSubscription?.status,
    stripePlanNickname: stripeSubscription?.planNickname,
    fallbackLabels: [
      activeOrgPlanTier,
      workspaceOrgPlanTier,
      subscription?.tier,
      usageMetricsResult.parseTierFromMetrics,
      subscription?.productName,
      subscription?.planName,
      subscription?.plan?.nickname,
      subscription?.plan?.name,
      ...parseSubscriptionLabels,
    ],
  });
  const limitsTier = isTrialPeriod ? "developer" : planTier;
  const limits = getPlanLimitsForTier(limitsTier);

  const usage = usageMetricsResult.usage;

  const role = await resolveWorkspaceRole(
    profile.sessionToken!,
    workspaceId,
    profile.userId,
  );
  const isWorkspaceOwner = role === "owner";
  const isWorkspaceAdmin = role === "admin" || isWorkspaceOwner;
  const isMeteredBillingOn =
    subscription?.isMeteredBillingOn ??
    usageMetricsResult.isMeteredBillingOnFromMetrics ??
    false;

  return {
    planName: planDisplayName(planTier),
    planTier,
    planFeatures: planFeaturesForTier(planTier),
    subscriptionStatus: stripeSubscription?.status ?? subscription?.status,
    trialEnd:
      formatStripeTrialEnd(stripeSubscription?.trialEnd) ??
      subscription?.trialEnd ??
      null,
    isTrialPeriod,
    cancelAtPeriodEnd: stripeSubscription?.cancelAtPeriodEnd ?? false,
    isWorkspaceOwner,
    isWorkspaceAdmin,
    canManageBilling: isWorkspaceOwner,
    stripeCustomerId,
    subscriptionObjectId: subscription?.objectId,
    isMeteredBillingOn,
    usage,
    limits,
    warnings: buildPlanWarnings(usage, limits, { isMeteredBillingOn }),
  };
}

async function createCustomerPortalUrl(customerId: string): Promise<string> {
  const response = await fetch(`${PAPR_PLATFORM_URL}/api/createCustomerPortalSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerId }),
  });

  const data = (await response.json()) as { url?: string; error?: string };
  if (!response.ok || !data.url) {
    throw new Error(data.error || "Unable to open billing portal");
  }
  return data.url;
}

async function createCheckoutUrl(input: {
  customerId: string;
  priceId: string;
  quantity?: number;
}): Promise<string> {
  const response = await fetch(`${PAPR_PLATFORM_URL}/api/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      priceId: input.priceId,
      customerId: input.customerId,
      quantity: input.quantity ?? 1,
      mode: "subscription",
      trial_period_days: 0,
      success_url: `${PAPR_PLATFORM_URL}/?checkout_success=true`,
      cancel_url: `${PAPR_PLATFORM_URL}/?checkout_canceled=true`,
    }),
  });

  const data = (await response.json()) as { url?: string; error?: string };
  if (!response.ok || !data.url) {
    throw new Error(data.error || "Unable to start checkout");
  }
  return data.url;
}

export function registerPaprBillingHandlers(deps: {
  settingsStorage: SettingsStorage;
  runGraphQLWithRefresh: GraphQLRunner;
}): void {
  const services: BillingServices = {
    settingsStorage: deps.settingsStorage,
    runGraphQL: deps.runGraphQLWithRefresh,
  };

  ipcMain.handle("papr:get-plan-summary", async () => {
    try {
      const summary = await getPlanSummaryCached(services);
      persistPlanSummaryToProfile(deps.settingsStorage, summary);
      return { success: true, summary };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load plan summary",
      };
    }
  });

  ipcMain.handle(
    "papr:open-billing-portal",
    async (_event, section?: "billing" | "subscriptions" | "invoices") => {
      try {
        const summary = await buildPlanSummary(services);
        if (!summary.canManageBilling) {
          throw new Error("Only the workspace owner can manage billing.");
        }
        if (!summary.stripeCustomerId) {
          throw new Error("No billing account found. Upgrade your plan first.");
        }
        const baseUrl = await createCustomerPortalUrl(summary.stripeCustomerId);
        const url = section ? `${baseUrl}#${section}` : baseUrl;
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to open billing portal",
        };
      }
    },
  );

  ipcMain.handle("papr:open-usage-dashboard", async () => {
    await shell.openExternal(PAPR_USAGE_URL);
    return { success: true };
  });

  ipcMain.handle(
    "papr:start-checkout",
    async (
      _event,
      input: { tier: PaprCheckoutTier; billingCycle: PaprBillingCycle },
    ) => {
      try {
        const summary = await buildPlanSummary(services);
        if (!summary.canManageBilling) {
          throw new Error("Only the workspace owner can change plans.");
        }
        if (!summary.stripeCustomerId) {
          throw new Error("No Stripe customer found for this workspace.");
        }

        const profile = requireLoggedInProfile(deps.settingsStorage);
        const priceId = PAPR_CHECKOUT_PRICE_IDS[input.tier][input.billingCycle];
        const members = await fetchWorkspaceMembers(
          profile.sessionToken!,
          profile.workspaceId!,
        );

        const url = await createCheckoutUrl({
          customerId: summary.stripeCustomerId,
          priceId,
          quantity: Math.max(members.length, 1),
        });
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to start checkout",
        };
      }
    },
  );

  ipcMain.handle("papr:set-metered-billing", async (_event, enabled: boolean) => {
    try {
      const summary = await buildPlanSummary(services);
      if (!summary.canManageBilling) {
        throw new Error("Only the workspace owner can change metered billing.");
      }
      if (!summary.subscriptionObjectId) {
        throw new Error("No active subscription found for this workspace.");
      }
      if (enabled) {
        const status = summary.subscriptionStatus;
        if (status !== "active" && status !== "trialing") {
          throw new Error(
            "Metered billing requires an active or trialing subscription.",
          );
        }
      }

      await services.runGraphQL(UPDATE_SUBSCRIPTION_METERED_BILLING, {
        input: {
          id: summary.subscriptionObjectId,
          fields: {
            isMeteredBillingOn: enabled,
          },
        },
      });

      invalidatePlanSummaryCache();
      return { success: true, enabled };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update metered billing",
      };
    }
  });
}
