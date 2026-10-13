/**
 * Credits plan picker for Settings → Billing.
 *
 * Same shape as the customer-facing pricing page in the Papr Unit Economics app:
 * Local / Cloud / Cloud Max (one card with a 5x · 20x toggle), price per person, the
 * credit grant shown as a dollar value, a short ticked feature list, and the one-time
 * Expert Builder service tucked into the Max card. Credits are per person, not pooled.
 */

import { useState } from "react";
import {
  PAPR_CREDIT_PLANS,
  PAPR_EXPERT_BUILDS,
  PAPR_EXPERT_BUILD_CONTACT,
  PAPR_LOCAL_PLAN,
  creditsUsdLabel,
  formatUsd,
  type PaprCreditPlanCard,
  type PaprCreditPlanId,
  type PaprExpertBuildSize,
} from "../../../src/core/types/paprCreditPlans";
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

const Tick = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.2 3.2L13 5" />
  </svg>
);

function Features({ items }: { items: readonly string[] }) {
  return (
    <ul className="cpc-feat">
      {items.map((t) => (
        <li key={t}><Tick /><span>{t}</span></li>
      ))}
    </ul>
  );
}

function PlanButton(props: Props & { plan: PaprCreditPlanCard; solid?: boolean }) {
  const { plan, currentPlan, canManageBilling, pending, onChoosePlan, solid } = props;
  if (currentPlan === plan.id) return <span className="cpc-current">Current plan</span>;
  const label = plan.variant ? `${plan.name} ${plan.variant}` : plan.name;
  return (
    <button
      type="button"
      className={solid ? "cpc-btn cpc-btn--solid" : "cpc-btn"}
      disabled={!canManageBilling || pending !== null}
      title={canManageBilling ? undefined : "Only the workspace owner can change plans"}
      onClick={() => onChoosePlan(plan.id)}
    >
      {pending === plan.id ? "Opening checkout…" : currentPlan ? `Switch to ${label}` : `Start on ${label}`}
    </button>
  );
}

function PriceBlock({ plan, from }: { plan: PaprCreditPlanCard; from?: boolean }) {
  return (
    <>
      <div className="cpc-price">
        {from ? <i className="cpc-from">From</i> : null}
        <b>{formatUsd(plan.pricePerSeat)}</b><i>/person/mo</i>
      </div>
      <div className="cpc-cred">{creditsUsdLabel(plan)} worth of credits per person</div>
    </>
  );
}

function ExpertBuilder(props: Props) {
  const { pending, onBuyExpertBuild, canManageBilling } = props;
  return (
    <details className="cpc-addon">
      <summary>
        <span><em>Add-on</em>Expert Builder</span>
        <b>From $500</b>
      </summary>
      <div className="cpc-addon-b">
        <p>A Papr engineer scopes, builds and hands over your app. One-time; the app runs on your plan's credits.</p>
        {PAPR_EXPERT_BUILDS.map((b) => (
          <div className="cpc-addon-r" key={b.size}>
            <div><u>{b.name}</u><small>{b.description}</small></div>
            {b.price === null ? (
              <a className="cpc-mini" href={PAPR_EXPERT_BUILD_CONTACT}>Contact us</a>
            ) : (
              <button
                type="button"
                className="cpc-mini"
                disabled={!canManageBilling || pending !== null}
                onClick={() => onBuyExpertBuild(b.size as PaprExpertBuildSize)}
              >
                {pending === `expert:${b.size}` ? "Opening…" : formatUsd(b.price)}
              </button>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

export function CreditPlanCards(props: Props) {
  const [cloud, max5, max20] = PAPR_CREDIT_PLANS as [PaprCreditPlanCard, PaprCreditPlanCard, PaprCreditPlanCard];
  const [maxSize, setMaxSize] = useState<PaprCreditPlanCard>(props.currentPlan === "cloud_max" ? max20 : max5);
  const maxFeatures = [`${maxSize.cloudApps} cloud apps & scheduled runs`, ...maxSize.unlocks, `Everything at ${maxSize.variant}`];

  return (
    <div className="cpc">
      <div className="cpc-grid">
        <div className="cpc-card cpc-card--free">
          <div className="cpc-n">{PAPR_LOCAL_PLAN.name}</div>
          <p className="cpc-blurb">{PAPR_LOCAL_PLAN.blurb}</p>
          <div className="cpc-price"><b>$0</b></div>
          <div className="cpc-cred">{PAPR_LOCAL_PLAN.creditsLine}</div>
          {props.onActivateLocal ? (
            <button type="button" className="cpc-btn" disabled={props.localPending || props.pending !== null}
              onClick={props.onActivateLocal}>
              {props.localPending ? "Activating…" : "Activate free plan"}
            </button>
          ) : null}
          <div className="cpc-plus">Included:</div>
          <Features items={PAPR_LOCAL_PLAN.features} />
        </div>

        <div className="cpc-card">
          <div className="cpc-n">{cloud.name}</div>
          <p className="cpc-blurb">{cloud.blurb}</p>
          <PriceBlock plan={cloud} />
          <PlanButton {...props} plan={cloud} />
          <div className="cpc-plus">Everything in Local, plus:</div>
          <Features items={[`${cloud.cloudApps} cloud app & scheduled runs`, ...cloud.unlocks]} />
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
          <PriceBlock plan={maxSize} from={maxSize.id === max5.id} />
          <PlanButton {...props} plan={maxSize} solid />
          <div className="cpc-plus">Everything in Cloud, plus:</div>
          <Features items={maxFeatures} />
          <ExpertBuilder {...props} />
        </div>
      </div>
      <p className="cpc-foot">
        Priced per person &mdash; every builder gets their own credits, not a shared pool. Anyone who
        just opens what you publish is free. Past your credits it's $1 per 1,000; we warn you before
        anything stops.
      </p>
    </div>
  );
}
