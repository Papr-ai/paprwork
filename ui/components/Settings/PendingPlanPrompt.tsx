/**
 * "You picked Cloud Max 5x on papr.ai" → one Continue to checkout button.
 * Shown at the top of Settings → Billing while a choice from the website is pending.
 */

import { useEffect, useState } from "react";
import type { PaprCreditPlanId, PaprPlanTrack } from "../../../src/core/types/paprCreditPlans";
import { planChoiceName, type PendingPlanChoice } from "../../../src/core/utils/paprPlanLink";
import { PENDING_PLAN_EVENT, clearPendingPlan, readPendingPlan } from "../../utils/pendingPlan";

/** Live view of the pending choice (updates when a new link arrives). */
export function usePendingPlan(): PendingPlanChoice | null {
  const [choice, setChoice] = useState<PendingPlanChoice | null>(() => readPendingPlan());
  useEffect(() => {
    const refresh = () => setChoice(readPendingPlan());
    window.addEventListener(PENDING_PLAN_EVENT, refresh);
    return () => window.removeEventListener(PENDING_PLAN_EVENT, refresh);
  }, []);
  return choice;
}

interface Props {
  choice: PendingPlanChoice;
  currentPlan: PaprCreditPlanId | null;
  canManageBilling: boolean;
  busy: boolean;
  onCheckout: (plan: PaprCreditPlanId, track: PaprPlanTrack) => Promise<boolean>;
}

export function PendingPlanPrompt({ choice, currentPlan, canManageBilling, busy, onCheckout }: Props) {
  // Already on it (e.g. paid on another device): nothing left to do.
  useEffect(() => {
    if (currentPlan === choice.plan) clearPendingPlan();
  }, [currentPlan, choice.plan]);
  if (currentPlan === choice.plan) return null;

  const name = planChoiceName(choice.plan);
  const perSeat = choice.track === "team" ? " for your team" : "";

  return (
    <div className="papr-plan__pending" role="status">
      <div className="papr-plan__pending-text">
        <strong>You picked {name}{perSeat}</strong>
        <span>
          {canManageBilling
            ? "Continue to checkout to start it on this workspace."
            : "Only this workspace's owners and admins can buy a plan. Ask one of them to upgrade."}
        </span>
      </div>
      <div className="papr-plan__pending-actions">
        {canManageBilling ? (
          <button
            type="button"
            className="papr-plan__primary-btn"
            disabled={busy}
            onClick={() => {
              void onCheckout(choice.plan, choice.track).then((ok) => {
                if (ok) clearPendingPlan();
              });
            }}
          >
            {busy ? "Opening checkout…" : "Continue to checkout"}
          </button>
        ) : null}
        <button type="button" className="papr-plan__link-btn" onClick={clearPendingPlan}>
          Not now
        </button>
      </div>
    </div>
  );
}
