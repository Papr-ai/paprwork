/**
 * Plan picked outside the app (papr.ai/pricing → papr://billing?plan=…&track=…).
 * Checkout itself always starts inside Papr Work after sign-in, so the payment lands
 * on the org the desktop meters (#961). This module only parses and validates the choice.
 */

import {
  PAPR_CREDIT_PLANS,
  isCreditPlanId,
  isPlanTrack,
  type PaprCreditPlanId,
  type PaprPlanTrack,
} from "../types/paprCreditPlans";

export interface PendingPlanChoice {
  plan: PaprCreditPlanId;
  track: PaprPlanTrack;
  /** ms since epoch, when the choice was made. */
  at: number;
}

/** How long a choice made on the website is offered back in the app. */
export const PENDING_PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Read plan/track from a papr://billing (or papr-dev://billing) link or its params. */
export function parsePlanChoice(
  input: { plan?: unknown; track?: unknown } | string | null | undefined,
  now = Date.now(),
): PendingPlanChoice | null {
  let plan: unknown;
  let track: unknown;
  if (typeof input === "string") {
    try {
      const params = new URL(input).searchParams;
      plan = params.get("plan");
      track = params.get("track");
    } catch {
      return null;
    }
  } else if (input) {
    plan = input.plan;
    track = input.track;
  }
  if (!isCreditPlanId(plan)) return null;
  return { plan, track: isPlanTrack(track) ? track : "individual", at: now };
}

/** A stored choice is still worth offering: valid shape and not expired. */
export function isFreshPlanChoice(value: unknown, now = Date.now()): value is PendingPlanChoice {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PendingPlanChoice>;
  return (
    isCreditPlanId(v.plan) &&
    isPlanTrack(v.track) &&
    typeof v.at === "number" &&
    now - v.at >= 0 &&
    now - v.at < PENDING_PLAN_TTL_MS
  );
}

export function planChoiceName(plan: PaprCreditPlanId): string {
  return PAPR_CREDIT_PLANS.find((p) => p.id === plan)?.name ?? plan;
}
