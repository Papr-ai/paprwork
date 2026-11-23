/**
 * PlanStep — "Pick your plan", shown once right after a new org is created.
 *
 * Uses the same plan cards as Settings → Billing (CreditPlanCards), so prices,
 * credits and features stay in one place. Checkout must start here, inside the
 * app, after the org exists: that puts the payment on the org Papr Work meters
 * (#961). A plan picked on papr.ai (papr://billing?plan=…) opens preselected.
 * Local is free and just continues; a paid plan opens Stripe in the browser and
 * setup carries on while they pay.
 */

import { useState } from "react";
import type { PaprCreditPlanId, PaprPlanTrack } from "../../../src/core/types/paprCreditPlans";
import { planChoiceName } from "../../../src/core/utils/paprPlanLink";
import { trackEvent } from "../../lib/telemetry";
import { clearPendingPlan, readPendingPlan } from "../../utils/pendingPlan";
import { CreditPlanCards, type CreditPlanAction } from "../Settings/CreditPlanCards";
import { AuthProgressDots } from "./AuthProgressDots";
import "./onboardingTheme.css";
import "./PlanStep.css";

interface PlanStepProps {
  /** Move on to the next setup step. */
  onDone: () => void;
  /** Settings → Dev preview: never opens a real checkout. */
  previewMode?: boolean;
}

export function PlanStep({ onDone, previewMode = false }: PlanStepProps) {
  const [pending] = useState(() => readPendingPlan());
  const [action, setAction] = useState<CreditPlanAction>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = (plan: string, outcome: "local" | "checkout" | "skipped") => {
    trackEvent("paprwork_onboarding_plan_chosen", {
      plan,
      outcome,
      from_website: Boolean(pending),
    } as Record<string, unknown>);
    if (!previewMode) clearPendingPlan();
    onDone();
  };

  const choosePlan = async (plan: PaprCreditPlanId, track: PaprPlanTrack) => {
    if (previewMode) return finish(plan, "checkout");
    setAction(plan);
    setError(null);
    try {
      const result = await window.electronAPI.papr.startCreditsCheckout({ plan, track });
      if (!result.success) {
        setError(result.error || "Could not open checkout. You can pick a plan later in Settings → Billing.");
        return;
      }
      finish(plan, "checkout");
    } finally {
      setAction(null);
    }
  };

  return (
    <div className="onboarding-flow onboarding-screen plan-step">
      <div className="onboarding-screen-inner plan-step__inner">
        <div className="onboarding-head-row">
          <div className="onboarding-head-row__start" aria-hidden />
          <div className="onboarding-head-row__center">
            <AuthProgressDots activeIndex={1} />
          </div>
          <div className="onboarding-head-row__end">
            <button type="button" className="onboarding-skip-btn" onClick={() => finish(pending?.plan ?? "none", "skipped")}>
              Skip for now
            </button>
          </div>
        </div>

        <h1 className="onboarding-h1">Pick your plan</h1>
        <p className="onboarding-lede">
          {pending
            ? `You picked ${planChoiceName(pending.plan)} on papr.ai. Start it below, or begin free on your own device.`
            : "Start free on your own device, or add the cloud so your apps and agents keep running while your laptop is shut."}{" "}
          You can change this anytime in Settings → Billing.
        </p>

        {error ? <p className="plan-step__error" role="alert">{error}</p> : null}

        <CreditPlanCards
          canManageBilling
          currentPlan={null}
          pending={action}
          defaultTrack={pending?.track ?? "individual"}
          initialPlan={pending?.plan ?? null}
          hideExpertBuild
          onChoosePlan={(plan, track) => void choosePlan(plan, track)}
          onBuyExpertBuild={() => undefined}
          onActivateLocal={() => finish("local", "local")}
          localLabel="Continue free"
        />

        <p className="onboarding-muted plan-step__note">
          Paid plans open checkout in your browser. Setup carries on here while you pay.
        </p>
      </div>
    </div>
  );
}
