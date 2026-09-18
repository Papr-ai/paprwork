import React from "react";
import { formatDuration } from "./contextMeterModel";
import {
  chatModelIsFable,
  CLAUDE_PLAN_USAGE_TITLE,
  formatCostAmount,
  getPlanUsageTooltipLines,
  planUsageBrand,
  resolveCostBasis,
  type PlanProvider,
  type PlanUsageSummary,
} from "../../utils/subscriptionPlanUsage";

type ContextPlanUsageHeroProps = {
  liveElapsedMs: number | null;
  planProvider: PlanProvider | null;
  chatModelId: string;
  planUsage: PlanUsageSummary | null;
  lastTurnCost: number | null;
};

function PlanInfoButton({
  tooltipLines,
  ariaLabel,
  alignEnd,
}: {
  tooltipLines: string[];
  ariaLabel: string;
  alignEnd?: boolean;
}) {
  return (
    <span
      className={
        alignEnd
          ? "ctx-panel__info-wrap ctx-panel__info-wrap--end"
          : "ctx-panel__info-wrap"
      }
    >
      <button type="button" className="ctx-panel__info" aria-label={ariaLabel}>
        i
      </button>
      <span className="ctx-panel__info-tip" role="tooltip">
        {tooltipLines.map((line) => (
          <span key={line} className="ctx-panel__info-tip-line">
            {line}
          </span>
        ))}
      </span>
    </span>
  );
}

export const ContextPlanUsageHero: React.FC<ContextPlanUsageHeroProps> = ({
  liveElapsedMs,
  planProvider,
  chatModelId,
  planUsage,
  lastTurnCost,
}) => {
  if (liveElapsedMs !== null) {
    return (
      <>
        <div className="ctx-panel__cost">{formatDuration(liveElapsedMs)}</div>
        <div className="ctx-panel__sub">running</div>
      </>
    );
  }

  /**
   * Once the included allowance is spent the provider bills per token on top
   * of the plan, so the plan percentage is no longer the headline — the money
   * is. Showing "Included" here was the defect: it is only true up to the
   * limit, and it read as reassurance to anyone already past it.
   */
  const scopedWeeklyApplies = chatModelIsFable(chatModelId);
  const basis = resolveCostBasis("subscription", planUsage, {
    scopedWeeklyApplies,
  });

  if (basis === "plan_overage" && lastTurnCost !== null) {
    return (
      <>
        <div className="ctx-panel__cost">{formatCostAmount(lastTurnCost)}</div>
        <div className="ctx-panel__sub">on top of plan</div>
      </>
    );
  }

  /**
   * With no readable plan there is nothing to be confident about.
   *
   * This branch used to render "Included / Subscription", which is only true
   * up to the limit — and since ChatGPT plan usage was never fetched at all,
   * every ChatGPT turn landed here and was declared included no matter how
   * far past its windows the account was. Saying the reading is unavailable
   * is less satisfying and does not mislead the one user it matters to.
   */
  if (!planProvider || !planUsage) {
    return (
      <>
        <div className="ctx-panel__cost">Plan</div>
        <div className="ctx-panel__sub">usage unavailable</div>
      </>
    );
  }

  const brand = planUsageBrand(planUsage.provider);
  const tooltipLines = getPlanUsageTooltipLines(planUsage, {
    includeFableWeekly: scopedWeeklyApplies,
  });

  return (
    <div className="ctx-panel__plan-compact">
      <div className="ctx-panel__plan-stack">
        <span className="ctx-panel__plan-stack-line">{brand}</span>
        <span className="ctx-panel__plan-stack-line">{CLAUDE_PLAN_USAGE_TITLE}</span>
      </div>
      <PlanInfoButton
        tooltipLines={tooltipLines}
        ariaLabel={`${brand} plan usage details`}
        alignEnd
      />
    </div>
  );
};
