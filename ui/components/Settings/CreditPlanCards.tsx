/**
 * Credits plan picker for Settings → Billing.
 *
 * A port of the customer-facing pricing page in the Papr Unit Economics app (Team track):
 * Cloud / Cloud Max (one card, 5x · 20x toggle, defaults to 5x "From $100") / Enterprise,
 * price per person, credits shown as a dollar value, apps & scheduled runs, storage, a
 * collapsible "Replaces $X/mo" strip and the collapsible Expert Builder add-on. The
 * per-person band explains seats; Local is the free baseline row underneath.
 */

import { useState } from "react";
import {
  PAPR_CREDIT_PLANS,
  PAPR_ENTERPRISE_PLAN,
  PAPR_LOCAL_PLAN,
  creditsUsdLabel,
  formatUsd,
  planFeatures,
  type PaprCreditPlanCard,
  type PaprCreditPlanId,
  type PaprExpertBuildSize,
} from "../../../src/core/types/paprCreditPlans";
import { ExpertBuilder, Features, ReplacesStrip } from "./CreditPlanParts";
import "./CreditPlanCards.css";

export type CreditPlanAction = PaprCreditPlanId | `expert:${PaprExpertBuildSize}` | null;

interface Props {
  canManageBilling: boolean;
  /** Current credits plan, if the org is already on one. */
  currentPlan?: PaprCreditPlanId | null;
  pending: CreditPlanAction;
  onChoosePlan: (plan: PaprCreditPlanId) => void;
  onBuyExpertBuild: (size: PaprExpertBuildSize) => void;
  /** Shown on Local only when the workspace has no active subscription at all. */
  onActivateLocal?: () => void;
  localPending?: boolean;
}

function PlanButton(props: Props & { plan: PaprCreditPlanCard; solid?: boolean }) {
  const { plan, currentPlan, canManageBilling, pending, onChoosePlan, solid } = props;
  if (currentPlan === plan.id) return <span className="cpc-current">Current plan</span>;
  return (
    <button
      type="button"
      className={solid ? "cpc-btn cpc-btn--solid" : "cpc-btn"}
      disabled={!canManageBilling || pending !== null}
      title={canManageBilling ? undefined : "Only the workspace owner can change plans"}
      onClick={() => onChoosePlan(plan.id)}
    >
      {pending === plan.id ? "Opening checkout…" : `${currentPlan ? "Switch to" : "Start on"} ${plan.name}`}
    </button>
  );
}

function PlanBody(props: Props & { plan: PaprCreditPlanCard; prev: string; from?: boolean; solid?: boolean }) {
  const { plan, prev, from } = props;
  return (
    <>
      <div className="cpc-price">
        {from ? <i className="cpc-from">From</i> : null}
        <b>{formatUsd(plan.pricePerSeat)}</b><i>/person/mo</i>
      </div>
      <div className="cpc-cred">{creditsUsdLabel(plan)} worth of credits per person</div>
      <PlanButton {...props} />
      <div className="cpc-plus">Everything in {prev}, plus:</div>
      <Features items={planFeatures(plan)} />
      <div className="cpc-foot"><ReplacesStrip tier={plan.replacesTier} /></div>
    </>
  );
}

export function CreditPlanCards(props: Props) {
  const [cloud, max5, max20] = PAPR_CREDIT_PLANS as [PaprCreditPlanCard, PaprCreditPlanCard, PaprCreditPlanCard];
  const [maxSize, setMaxSize] = useState<PaprCreditPlanCard>(props.currentPlan === "cloud_max" ? max20 : max5);
  const expertPending = props.pending?.startsWith("expert:")
    ? (props.pending.slice(7) as PaprExpertBuildSize) : null;

  return (
    <div className="cpc">
      <div className="cpc-grid">
        <div className="cpc-card">
          <div className="cpc-n">{cloud.name}</div>
          <p className="cpc-blurb">{cloud.blurb}</p>
          <PlanBody {...props} plan={cloud} prev="Local" />
        </div>

        <div className="cpc-card cpc-card--feat">
          <div className="cpc-tag">Most popular</div>
          <div className="cpc-head">
            <div className="cpc-n">Cloud Max</div>
            <div className="cpc-seg" role="group" aria-label="Cloud Max size">
              {[max5, max20].map((p) => (
                <button key={p.id} type="button" className={maxSize.id === p.id ? "on" : ""}
                  aria-pressed={maxSize.id === p.id} onClick={() => setMaxSize(p)}>{p.variant}</button>
              ))}
            </div>
          </div>
          <p className="cpc-blurb">{maxSize.blurb}</p>
          <PlanBody {...props} plan={maxSize} prev="Cloud" from={maxSize.id === max5.id} solid />
          <ExpertBuilder
            canBuy={props.canManageBilling && props.pending === null}
            pendingSize={expertPending}
            onBuy={props.onBuyExpertBuild}
          />
        </div>

        <div className="cpc-card">
          <div className="cpc-n">{PAPR_ENTERPRISE_PLAN.name}</div>
          <p className="cpc-blurb">{PAPR_ENTERPRISE_PLAN.blurb}</p>
          <div className="cpc-price"><b>Custom</b></div>
          <div className="cpc-cred">{PAPR_ENTERPRISE_PLAN.creditsLine}</div>
          <a className="cpc-btn" href={PAPR_ENTERPRISE_PLAN.contact}>Contact sales</a>
          <div className="cpc-plus">Everything in Cloud Max, plus:</div>
          <Features items={PAPR_ENTERPRISE_PLAN.features} />
        </div>
      </div>

      <div className="cpc-seat">
        <b>Priced per person<i> / credits per person</i></b>
        <p>Every teammate gets their own allowance &mdash; not a shared pool. Anyone who just
          opens what you published is free and unlimited. Past your credits it&rsquo;s $1 per
          1,000; we tell you before anything stops.</p>
      </div>

      <div className="cpc-local">
        <div>
          <b>{PAPR_LOCAL_PLAN.name} &middot; $0</b>
          <span>{PAPR_LOCAL_PLAN.blurb}. {PAPR_LOCAL_PLAN.creditsLine}.</span>
        </div>
        {props.onActivateLocal ? (
          <button type="button" className="cpc-mini" disabled={props.localPending || props.pending !== null}
            onClick={props.onActivateLocal}>
            {props.localPending ? "Activating…" : "Activate free plan"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
