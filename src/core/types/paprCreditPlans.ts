/**
 * Credits plan catalog shown in Settings → Billing.
 *
 * Mirrors the customer-facing pricing page in the Papr Unit Economics app (Team track:
 * priced per person, credits per person, not pooled) and the memory server's
 * config/credits.yaml. Stripe prices are addressed by lookup key on the server
 * (dashboard /api/v1/billing/credits-checkout), so nothing here holds a price id.
 */

export type PaprCreditPlanId = "cloud" | "cloud_plus" | "cloud_max";
export type PaprExpertBuildSize = "medium" | "large";

export interface PaprCreditPlanCard {
  id: PaprCreditPlanId;
  /** Full plan name, e.g. "Cloud Max 5x" (used on the button). */
  name: string;
  /** Toggle label on the Cloud Max card ("5x" / "20x"); null for Cloud. */
  variant: string | null;
  blurb: string;
  pricePerSeat: number;
  creditsPerSeat: number;
  /** Hosted apps + daily scheduled runs, shown to buyers as ONE number. */
  cloudApps: number;
  scheduledRuns: number;
  storageGb: number;
  unlocks: string[];
  /** Scope tier for the "Replaces $X/mo" strip (cumulative). */
  replacesTier: 1 | 2 | 3;
}

/** One credit = $0.001 of work, so the credit grant reads as a dollar value. */
export const USD_PER_CREDIT = 0.001;

export const PAPR_LOCAL_PLAN = {
  name: "Local",
  blurb: "Runs on your own device",
  creditsLine: "$5 of cloud credits to try publishing",
  features: [
    "Apps and agents, as many as your device can run",
    "Basic memory",
    "Community apps and skills",
    "Scheduled work runs only while your laptop is awake",
    "Full editor app building",
  ],
} as const;

const MAX_UNLOCKS = ["Max memory", "Custom domains", "Premium document processing", "Long-running agents"];

export const PAPR_CREDIT_PLANS: readonly PaprCreditPlanCard[] = [
  {
    id: "cloud",
    name: "Cloud",
    variant: null,
    blurb: "Runs some of your work",
    pricePerSeat: 30,
    creditsPerSeat: 30_000,
    cloudApps: 1,
    scheduledRuns: 2,
    storageGb: 15,
    unlocks: ["Enhanced memory", "Papr cloud domains", "Runs while your laptop is shut", "Team workspace"],
    replacesTier: 1,
  },
  {
    id: "cloud_plus",
    name: "Cloud Max 5x",
    variant: "5x",
    blurb: "Runs your everyday work",
    pricePerSeat: 100,
    creditsPerSeat: 150_000,
    cloudApps: 5,
    scheduledRuns: 10,
    storageGb: 75,
    unlocks: [...MAX_UNLOCKS, "Everything at 5x"],
    replacesTier: 2,
  },
  {
    id: "cloud_max",
    name: "Cloud Max 20x",
    variant: "20x",
    blurb: "Runs all of your work",
    pricePerSeat: 300,
    creditsPerSeat: 500_000,
    cloudApps: 15,
    scheduledRuns: 35,
    storageGb: 200,
    unlocks: [...MAX_UNLOCKS, "Everything at 20x"],
    replacesTier: 3,
  },
];

export const PAPR_ENTERPRISE_PLAN = {
  name: "Enterprise",
  blurb: "For companies rolling out across teams",
  creditsLine: "Volume pricing & pooled credits",
  contact: "mailto:sales@papr.ai?subject=Papr%20Enterprise",
  features: [
    "SSO / SAML & SCIM provisioning",
    "Admin console, roles & audit logs",
    "Data residency & private deployment",
    "Uptime SLA, security review & DPA",
    "Dedicated success manager & onboarding",
  ],
} as const;

export interface PaprExpertBuildOption {
  size: PaprExpertBuildSize | "xl";
  name: string;
  /** null = quoted ("Contact us"), not self-serve. */
  price: number | null;
  description: string;
}

export const PAPR_EXPERT_BUILDS: readonly PaprExpertBuildOption[] = [
  {
    size: "medium",
    name: "Medium app",
    price: 500,
    description: "One workflow end to end: a few integrations, a database, a scheduled job and a simple UI.",
  },
  {
    size: "large",
    name: "Large app",
    price: 1500,
    description: "Several workflows and data sources, custom logic, dashboards and team roles.",
  },
  {
    size: "xl",
    name: "XL app",
    price: null,
    description:
      "System-level builds: many integrations, heavy data, compliance or SLA needs. Maintenance is sold separately as engineer hours.",
  },
];

export const PAPR_EXPERT_BUILD_CONTACT = "mailto:sales@papr.ai?subject=Expert%20Build%20%E2%80%94%20XL%20app";

export function creditsUsdLabel(plan: Pick<PaprCreditPlanCard, "creditsPerSeat">): string {
  return `$${Math.round(plan.creditsPerSeat * USD_PER_CREDIT).toLocaleString("en-US")}`;
}

export function formatUsd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

/** Card bullets, in the same order as the Unit Economics pricing page. */
export type PaprPlanTrack = "individual" | "team";

export function isPlanTrack(value: unknown): value is PaprPlanTrack {
  return value === "individual" || value === "team";
}

/** "Team workspace" only shows on the Team track — an individual plan is one person. */
export function planFeatures(plan: PaprCreditPlanCard, track: PaprPlanTrack = "team"): string[] {
  return [
    `${plan.cloudApps + plan.scheduledRuns} cloud apps & scheduled runs`,
    ...plan.unlocks.filter((u) => track === "team" || u !== "Team workspace"),
    `${plan.storageGb} GB of storage`,
  ];
}

/** Monthly total for N builder seats (before any overage). */
export function monthlyTotal(plan: Pick<PaprCreditPlanCard, "pricePerSeat">, seats: number): number {
  return plan.pricePerSeat * Math.max(1, Math.floor(seats || 1));
}

export function isCreditPlanId(value: unknown): value is PaprCreditPlanId {
  return PAPR_CREDIT_PLANS.some((p) => p.id === value);
}

export function isSelfServeExpertBuild(value: unknown): value is PaprExpertBuildSize {
  return value === "medium" || value === "large";
}
