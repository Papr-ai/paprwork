/**
 * PlanStep — "Pick your plan", shown once right after a new org is created.
 *
 * Checkout must start here, inside the app, after the org exists: that is what
 * puts the payment on the org Papr Work meters (#961). Anyone who picked a plan
 * on papr.ai (papr://billing?plan=…) arrives with it preselected.
 * Local is free and just continues; a paid plan opens Stripe in the browser and
 * setup carries on while they pay.
 */

import { useState } from "react";
import {
  PAPR_CREDIT_PLANS,
  PAPR_LOCAL_PLAN,
  formatUsd,
  type PaprCreditPlanId,
  type PaprPlanTrack,
} from "../../../src/core/types/paprCreditPlans";
import { trackEvent } from "../../lib/telemetry";
import { clearPendingPlan, readPendingPlan } from "../../utils/pendingPlan";
import { AuthProgressDots } from "./AuthProgressDots";
import "./onboardingTheme.css";
import "./PlanStep.css";

type Choice = "local" | PaprCreditPlanId;

interface PlanStepProps {
  /** Move on to the next setup step. */
  onDone: () => void;
  /** Settings → Dev preview: never opens a real checkout. */
  previewMode?: boolean;
}

function planOptions(track: PaprPlanTrack): { id: Choice; name: string; price: string; line: string }[] {
  const per = track === "team" ? "/person/mo" : "/mo";
  return [
    { id: "local", name: PAPR_LOCAL_PLAN.name, price: "Free", line: PAPR_LOCAL_PLAN.blurb },
    ...PAPR_CREDIT_PLANS.map((p) => ({
      id: p.id as Choice,
      name: p.name,
      price: `${formatUsd(p.pricePerSeat)}${per}`,
      line: p.blurb,
    })),
  ];
}

export function PlanStep({ onDone, previewMode = false }: PlanStepProps) {
  const pending = readPendingPlan();
  const [choice, setChoice] = useState<Choice>(pending?.plan ?? "local");
  const track: PaprPlanTrack = pending?.track ?? "individual";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (plan: Choice, outcome: "local" | "checkout" | "skipped") => {
    trackEvent("paprwork_onboarding_plan_chosen", {
      plan,
      outcome,
      from_website: Boolean(pending),
    } as Record<string, unknown>);
    if (!previewMode) clearPendingPlan();
    onDone();
  };

  const handleContinue = async () => {
    if (choice === "local") return finish("local", "local");
    if (previewMode) return finish(choice, "checkout");
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.papr.startCreditsCheckout({ plan: choice, track });
      if (!result.success) {
        setError(result.error || "Could not open checkout. You can pick a plan later in Settings → Billing.");
        return;
      }
      finish(choice, "checkout");
    } finally {
      setBusy(false);
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
            <button type="button" className="onboarding-skip-btn" onClick={() => finish(choice, "skipped")}>
              Skip for now
            </button>
          </div>
        </div>

        <h1 className="onboarding-h1">Pick your plan</h1>
        <p className="onboarding-lede">
          Start free on your own device, or add the cloud so your apps and agents keep running
          while your laptop is shut. You can change this anytime in Settings → Billing.
        </p>

        <div className="plan-step__list" role="radiogroup" aria-label="Plan">
          {planOptions(track).map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={choice === o.id}
              className={choice === o.id ? "plan-step__opt on" : "plan-step__opt"}
              onClick={() => setChoice(o.id)}
            >
              <span className="plan-step__name">{o.name}</span>
              <span className="plan-step__line">{o.line}</span>
              <span className="plan-step__price">{o.price}</span>
            </button>
          ))}
        </div>

        {error ? <p className="plan-step__error" role="alert">{error}</p> : null}

        <button
          type="button"
          className="onboarding-cta onboarding-cta--wide plan-step__cta"
          disabled={busy}
          onClick={() => void handleContinue()}
        >
          {busy ? "Opening checkout…" : choice === "local" ? "Continue free" : "Continue to checkout"}
        </button>
        {choice === "local" ? null : (
          <p className="onboarding-muted plan-step__note">
            Checkout opens in your browser. Setup carries on here while you pay.
          </p>
        )}
      </div>
    </div>
  );
}
