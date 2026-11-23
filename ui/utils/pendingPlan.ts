/**
 * The plan someone picked on papr.ai before (or without) being inside the app.
 * Stored locally so it survives sign-in and org setup; offered back as one
 * "Continue to checkout" button in Settings → Billing and on the first-run plan screen.
 */

import {
  isFreshPlanChoice,
  parsePlanChoice,
  type PendingPlanChoice,
} from "../../src/core/utils/paprPlanLink";

const STORAGE_KEY = "papr-pending-plan-v1";
export const PENDING_PLAN_EVENT = "papr:pending-plan-changed";

function announce(): void {
  window.dispatchEvent(new CustomEvent(PENDING_PLAN_EVENT));
}

export function readPendingPlan(): PendingPlanChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (isFreshPlanChoice(parsed)) return parsed;
    if (raw) localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* unreadable storage: nothing pending */
  }
  return null;
}

/** Remember a choice from a deep link. Returns it if it was valid. */
export function savePendingPlan(input: { plan?: unknown; track?: unknown }): PendingPlanChoice | null {
  const choice = parsePlanChoice(input);
  if (!choice) return null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    /* storage full/blocked: the Billing prompt just won't appear */
  }
  announce();
  return choice;
}

export function clearPendingPlan(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  announce();
}
