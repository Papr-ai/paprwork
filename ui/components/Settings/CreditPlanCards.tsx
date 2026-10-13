/**
 * Credits plan picker for Settings → Billing.
 *
 * A port of the customer-facing pricing page in the Papr Unit Economics app, with the same
 * Individual / Team toggle:
 *  - Individual: Local · Cloud · Cloud Max, priced per month, one person.
 *  - Team: Cloud · Cloud Max · Enterprise, priced per person, credits per person. No Local —
 *    collaborating needs the cloud.
 * Cloud Max is one card with a 5x · 20x toggle that defaults to 5x ("From $100").
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
  type PaprPlanTrack,
} from "../../../src/core/types/paprCreditPlans";
import { ExpertBuilder, Features, ReplacesStrip } from "./CreditPlanParts";
import "./CreditPlanCards.css";

export type CreditPlanAction = PaprCreditPlanId | `expert:${PaprExpertBuildSize}` | null;

interface Props {
  canManageBilling: boolean;
  /** Current credits plan, if the org is already on one. */
  currentPlan?: PaprCreditPlanId | null;
  pending: CreditPlanAction;
  /** Track the toggle opens on. Defaults to Team. */
  defaultTrack?: PaprPlanTrack;
  onChoosePlan: (plan: PaprCreditPlanId, track: PaprPlanTrack) => void;
  onBuyExpertBuild: (size: PaprExpertBuildSize) => void;
  /** Shown on Local only when the workspace has no active subscription at all. */
  onActivateLocal?: () => void;
  localPending?: boolean;
}

type CardProps = Props & { track: PaprPlanTrack };

function PlanButton(props: CardProps & { plan: PaprCreditPlanCard; solid?: boolean }) {
  const { plan, currentPlan, canManageBilling, pending, onChoosePlan, solid, track } = props;
  if (currentPlan === plan.id) return <span className="cpc-current">Current plan</span>;
  return (
    <button
      type="button"
      className={solid ? "cpc-btn cpc-btn--solid" : "cpc-btn"}
      disabled={!canManageBilling || pending !== null}
      title={canManageBilling ? undefined : "Only the workspace owner can change plans"}
      onClick={() => onChoosePlan(plan.id, track)}
    >
      {pending === plan.id ? "Opening checkout…" : `${currentPlan ? "Switch to" : "Start on"} ${plan.name}`}
    </button>
  );
}

function PlanBody(props: CardProps & { plan: PaprCreditPlanCard; prev: string; from?: boolean; solid?: boolean }) {
  const { plan, prev, from, track } = props;
  const team = track === "team";
  return (
    <>
      <div className="cpc-price">
        {from ? <i className="cpc-from">From</i> : null}
        <b>{formatUsd(plan.pricePerSeat)}</b><i>{team ? "/person/mo" : "/month"}</i>
      </div>
      <div className="cpc-cred">{creditsUsdLabel(plan)} worth of credits{team ? " per person" : ""}</div>
      <PlanButton {...props} />
      <div className="cpc-plus">Everything in {prev}, plus:</div>
      <Features items={planFeatures(plan, track)} />
      <div className="cpc-foot"><ReplacesStrip tier={plan.replacesTier} /></div>
    </>
  );
}

function LocalCard(props: CardProps) {
  return (
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
  );
}

function EnterpriseCard() {
  return (
    <div className="cpc-card">
      <div className="cpc-n">{PAPR_ENTERPRISE_PLAN.name}</div>
      <p className="cpc-blurb">{PAPR_ENTERPRISE_PLAN.blurb}</p>
      <div className="cpc-price"><b>Custom</b></div>
      <div className="cpc-cred">{PAPR_ENTERPRISE_PLAN.creditsLine}</div>
      <a className="cpc-btn" href={PAPR_ENTERPRISE_PLAN.contact}>Contact sales</a>
      <div className="cpc-plus">Everything in Cloud Max, plus:</div>
      <Features items={PAPR_ENTERPRISE_PLAN.features} />
    </div>
  );
}

export function CreditPlanCards(props: Props) {
  const [cloud, max5, max20] = PAPR_CREDIT_PLANS as [PaprCreditPlanCard, PaprCreditPlanCard, PaprCreditPlanCard];
  const [track, setTrack] = useState<PaprPlanTrack>(props.defaultTrack ?? "team");
  const [maxSize, setMaxSize] = useState<PaprCreditPlanCard>(props.currentPlan === "cloud_max" ? max20 : max5);
  const expertPending = props.pending?.startsWith("expert:")
    ? (props.pending.slice(7) as PaprExpertBuildSize) : null;
  const team = track === "team";
  const card: CardProps = { ...props, track };

  return (
    <div className="cpc">
      <div className="cpc-track">
        <div className="cpc-seg cpc-seg--lg" role="group" aria-label="Plan type">
          {(["individual", "team"] as const).map((t) => (
            <button key={t} type="button" className={track === t ? "on" : ""}
              aria-pressed={track === t} onClick={() => setTrack(t)}>
              {t === "team" ? "Team" : "Individual"}
            </button>
          ))}
        </div>
      </div>

      <div className="cpc-grid">
        {team ? null : <LocalCard {...card} />}

        <div className="cpc-card">
          <div className="cpc-n">{cloud.name}</div>
          <p className="cpc-blurb">{cloud.blurb}</p>
          <PlanBody {...card} plan={cloud} prev="Local" />
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
          <PlanBody {...card} plan={maxSize} prev="Cloud" from={maxSize.id === max5.id} solid />
          <ExpertBuilder
            canBuy={props.canManageBilling && props.pending === null}
            pendingSize={expertPending}
            onBuy={props.onBuyExpertBuild}
          />
        </div>

        {team ? <EnterpriseCard /> : null}
      </div>

      <div className="cpc-seat">
        {team ? (
          <>
            <b>Priced per person<i> / credits per person</i></b>
            <p>Every teammate gets their own allowance &mdash; not a shared pool. Anyone who just
              opens what you published is free and unlimited. Past your credits it&rsquo;s $1 per
              1,000; we tell you before anything stops.</p>
          </>
        ) : (
          <>
            <b>Just you<i> / one person</i></b>
            <p>Individual plans are for one person. When others need to build alongside you, move
              to Team. Anyone who just opens what you published is free and unlimited.</p>
          </>
        )}
      </div>
    </div>
  );
}
