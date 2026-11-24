/**
 * What a subscription costs per month, for the Agents page plan section.
 *
 * The usage APIs say *which* plan a login is on, never what it costs, so list
 * prices live here (monthly billing, USD). They are a starting point: the page
 * lets the user overwrite them with what their invoice says, because annual
 * billing, seat type and negotiated pricing all move the real figure.
 *
 * Sources (2026-11-17): https://claude.com/pricing, https://chatgpt.com/pricing
 */

import type { PlanProvider } from "./subscriptionPlanUsage";

export interface PlanPriceGuess {
  /** e.g. "Team · Premium seat" */
  label: string;
  /** USD per month at list price, or null when the tier's price is unknown. */
  monthlyUsd: number | null;
}

export interface ClaudePlanFields {
  organizationType?: string | null;
  rateLimitTier?: string | null;
  seatTier?: string | null;
  subscriptionType?: string | null;
}

/** Claude: organization_type + rate_limit_tier from /api/oauth/profile. */
export function guessClaudePlan(p: ClaudePlanFields | null | undefined): PlanPriceGuess | null {
  if (!p) return null;
  const org = (p.organizationType ?? "").toLowerCase();
  const tier = (p.rateLimitTier ?? "").toLowerCase();
  const sub = (p.subscriptionType ?? "").toLowerCase();
  const is20x = tier.includes("20x");
  const is5x = tier.includes("5x");

  if (org.includes("enterprise") || sub === "enterprise") {
    return { label: "Enterprise", monthlyUsd: null };
  }
  if (org.includes("team") || sub === "team") {
    // Team seats: Standard $25, Premium $125 billed monthly. A premium seat
    // carries the Max-style 5x rate-limit tier.
    return is5x || is20x
      ? { label: "Team · Premium seat", monthlyUsd: 125 }
      : { label: "Team · Standard seat", monthlyUsd: 25 };
  }
  if (is20x) return { label: "Ultra (Max 20x)", monthlyUsd: 200 };
  if (is5x || org.includes("max") || sub === "max") return { label: "Max", monthlyUsd: 100 };
  if (org.includes("pro") || sub === "pro") return { label: "Pro", monthlyUsd: 20 };
  if (!org && !tier && !sub) return null;
  return { label: titleCase(sub || org.replace(/^claude_/, "")), monthlyUsd: null };
}

/** ChatGPT: `plan_type` from the usage endpoint. */
export function guessChatGptPlan(planType: string | null | undefined): PlanPriceGuess | null {
  const t = (planType ?? "").toLowerCase();
  if (!t) return null;
  if (t === "go") return { label: "Go", monthlyUsd: 8 };
  if (t === "plus") return { label: "Plus", monthlyUsd: 20 };
  // Pro comes in three tiers ($100 / $200 / $500); the API does not say which.
  if (t.startsWith("pro")) return { label: "Pro", monthlyUsd: 100 };
  if (t === "team" || t === "business") return { label: "Business", monthlyUsd: null };
  if (t.includes("enterprise") || t === "edu") return { label: titleCase(t), monthlyUsd: null };
  return { label: titleCase(t), monthlyUsd: null };
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

const PRICE_KEY = (provider: PlanProvider) => `papr.planPrice.v1.${provider}`;

/** The user's own monthly price for this plan, if they set one. */
export function readPlanPriceOverride(provider: PlanProvider): number | null {
  try {
    const raw = localStorage.getItem(PRICE_KEY(provider));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function writePlanPriceOverride(provider: PlanProvider, usd: number | null): void {
  try {
    if (usd === null) localStorage.removeItem(PRICE_KEY(provider));
    else localStorage.setItem(PRICE_KEY(provider), String(usd));
  } catch {
    /* private mode: the guess still shows */
  }
}

/**
 * Month-to-date money for the plan section. Plans are charged in full each
 * month, so they count whole; everything else is what was billed on top.
 */
export function monthTotal(input: {
  planUsd: Array<number | null>;
  apiKeyUsd: number;
  paprUsd: number;
  providerExtraUsd: number;
}): { plans: number; extra: number; total: number; plansKnown: boolean } {
  const plans = input.planUsd.reduce<number>((a, n) => a + (n ?? 0), 0);
  const extra = input.apiKeyUsd + input.paprUsd + input.providerExtraUsd;
  return {
    plans,
    extra,
    total: plans + extra,
    plansKnown: input.planUsd.every((n) => n !== null),
  };
}
