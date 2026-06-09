import React from "react";
import { MetricPeriodSummary } from "./MetricPeriodSummary";
import { SavingsCompare } from "./SavingsCompare";
import {
  UsageTrendChart,
  type DailyUsageTrend,
} from "./UsageTrendChart";
import type { ContextEfficiencyStats } from "./ContextEfficiencyCard";
import { ModelBreakdown, type ModelUsageRow } from "./ModelBreakdown";

interface CostStats {
  today: number;
  thisWeek: number;
  thisMonth: number;
  total: number;
  totalMessages: number;
  topModels: ModelUsageRow[];
}

interface Props {
  costStats: CostStats | null;
  efficiency?: ContextEfficiencyStats | null;
  efficiencyLoading?: boolean;
  dailyTrends?: DailyUsageTrend[] | null;
  trendsLoading?: boolean;
  trendRange?: 7 | 30 | 90;
  onTrendRangeChange?: (days: 7 | 30 | 90) => void;
}

export function CostOverviewCard({
  costStats,
  efficiency = null,
  efficiencyLoading = false,
  dailyTrends = null,
  trendsLoading = false,
  trendRange = 30,
  onTrendRangeChange,
}: Props) {
  if (!costStats) {
    return (
      <div className="metric-card">
        <div className="card-header">
          <div className="card-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
            Cost Overview
          </div>
        </div>
        <div className="card-content">
          <div className="loading-message">Loading cost data...</div>
        </div>
      </div>
    );
  }

  const showSavings =
    efficiency !== null &&
    efficiency.lifetimeCostSaved > 0 &&
    !efficiencyLoading;

  const savingsBadge =
    showSavings && efficiency.costEfficiencyScore > 0
      ? `${efficiency.costEfficiencyScore}% saved`
      : null;

  return (
    <div className="metric-card">
      <div className="card-header">
        <div className="card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          Cost Overview
        </div>
        {savingsBadge ? (
          <div className="card-badge cost-saved-badge">{savingsBadge}</div>
        ) : null}
      </div>

      <div className="card-content">
        <MetricPeriodSummary
          label="Total spend"
          total={costStats.total}
          sublabel={`${costStats.totalMessages.toLocaleString()} messages`}
          periods={{
            today: costStats.today,
            thisWeek: costStats.thisWeek,
            thisMonth: costStats.thisMonth,
          }}
          format="cost"
        />

        {showSavings ? (
          <SavingsCompare
            actual={efficiency.actualCost}
            hypothetical={efficiency.hypotheticalCostWithoutOptimizations}
            saved={efficiency.lifetimeCostSaved}
            format="cost"
            compact
          />
        ) : efficiencyLoading ? (
          <div className="cost-savings-loading">Computing cost savings…</div>
        ) : null}

        <UsageTrendChart
          trends={dailyTrends}
          metric="cost"
          loading={trendsLoading}
          range={trendRange}
          onRangeChange={onTrendRangeChange}
        />

        <ModelBreakdown
          models={costStats.topModels ?? []}
          total={costStats.total}
          metric="cost"
        />
      </div>

      <style>{`
        .cost-saved-badge {
          color: #059669;
          background: rgba(5, 150, 105, 0.1);
        }

        .cost-savings-loading {
          font-size: 10px;
          color: var(--text-tertiary);
          margin-bottom: 8px;
        }

        .loading-message {
          text-align: center;
          padding: 24px 12px;
          color: var(--text-secondary);
          font-size: 12px;
        }
      `}</style>
    </div>
  );
}
