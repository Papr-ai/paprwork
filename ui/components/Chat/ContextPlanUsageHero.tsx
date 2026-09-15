import React from "react";
import { formatDuration } from "./contextMeterModel";
import {
  chatModelIsFable,
  CLAUDE_PLAN_USAGE_BRAND,
  CLAUDE_PLAN_USAGE_TITLE,
  formatCostAmount,
  getPlanUsageTooltipLines,
  resolveCostBasis,
  type PlanUsageSummary,
} from "../../utils/subscriptionPlanUsage";

type ContextPlanUsageHeroProps = {
  liveElapsedMs: number | null;
  showClaudePlanUsage: boolean;
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
  showClaudePlanUsage,
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
  const overage =
    resolveCostBasis("subscription", planUsage) === "plan_overage";
  if (overage && lastTurnCost !== null) {
    return (
      <>
        <div className="ctx-panel__cost">{formatCostAmount(lastTurnCost)}</div>
        <div className="ctx-panel__sub">on top of plan</div>
      </>
    );
  }

  if (!showClaudePlanUsage) {
    return (
      <>
        <div className="ctx-panel__cost">Included</div>
        <div className="ctx-panel__sub">Subscription</div>
      </>
    );
  }

  const tooltipLines = getPlanUsageTooltipLines(planUsage, {
    includeFableWeekly: chatModelIsFable(chatModelId),
  });

  return (
    <div className="ctx-panel__plan-compact">
      <div className="ctx-panel__plan-stack">
        <span className="ctx-panel__plan-stack-line">{CLAUDE_PLAN_USAGE_BRAND}</span>
        <span className="ctx-panel__plan-stack-line">{CLAUDE_PLAN_USAGE_TITLE}</span>
      </div>
      <PlanInfoButton
        tooltipLines={tooltipLines}
        ariaLabel="Claude plan usage details"
        alignEnd
      />
    </div>
  );
};
