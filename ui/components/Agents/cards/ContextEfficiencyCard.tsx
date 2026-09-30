import React from "react";

export interface ContextEfficiencyPeriodStats {
  actualTokens: number;
  hypotheticalTokensWithoutOptimizations: number;
  tokensSaved: number;
  efficiencyScore: number;
}

export interface ContextEfficiencyStats {
  fullChatTokensPerTurn: number;
  agentContextTokensPerTurn: number;
  truncationTokensSaved: number;
  summaryTokensSaved: number;
  memorySearchTokensSaved: number;
  totalTokensSaved: number;
  totalTokensConsumed: number;
  hypotheticalTokensWithoutOptimizations: number;
  lifetimeTokensSaved: number;
  contextInflationRatio: number;
  efficiencyScore: number;
  actualCost?: number;
  hypotheticalCostWithoutOptimizations?: number;
  lifetimeCostSaved?: number;
  costEfficiencyScore?: number;
  dataSource?: "cached" | "partial" | "live";
  pendingFootprintTurns?: number;
  periods?: {
    today: ContextEfficiencyPeriodStats;
    thisWeek: ContextEfficiencyPeriodStats;
    thisMonth: ContextEfficiencyPeriodStats;
  };
  breakdown: {
    chatsAnalyzed: number;
    chatsWithSummaries: number;
    assistantTurnsAnalyzed: number;
    memorySearchCount: number;
    hybridBashCount: number;
    memoryHitsAnalyzed: number;
    memoryHitsWithSource: number;
    fullReadAvgTokens: number;
    memorySearchAvgTokens: number;
  };
}

interface Props {
  stats: ContextEfficiencyStats | null;
  loading?: boolean;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function ContextEfficiencyCard({ stats, loading = false }: Props) {
  const pendingTurns = stats?.pendingFootprintTurns ?? 0;
  const isBackfilling = pendingTurns > 0;
  const isComputing =
    loading ||
    (stats !== null &&
      stats.breakdown.chatsAnalyzed === 0 &&
      !isBackfilling);

  if (!stats || isComputing) {
    return (
      <div className="metric-card">
        <div className="card-header">
          <div className="card-title">Context Efficiency</div>
        </div>
        <div className="card-content">
          <div className="empty-state">
            <div className="empty-text">
              {loading || stats === null
                ? "Computing efficiency (large history)…"
                : "Efficiency data still computing — refresh in a few seconds"}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="metric-card">
      <div className="card-header">
        <div className="card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          Context Efficiency
        </div>
        <div className="card-badge efficiency-badge">
          {stats.efficiencyScore}% saved
        </div>
      </div>

      <div className="card-content">
        <div className="efficiency-usage-compare">
          <div className="usage-row">
            <span className="usage-label">You used (billable)</span>
            <span className="usage-value actual">
              {formatTokens(stats.totalTokensConsumed)}
            </span>
          </div>
          <div className="usage-row">
            <span className="usage-label">Without Paprwork (estimated)</span>
            <span className="usage-value hypothetical">
              {formatTokens(stats.hypotheticalTokensWithoutOptimizations)}
            </span>
          </div>
          <div className="usage-row saved-row">
            <span className="usage-label">You saved</span>
            <span className="usage-value saved">
              {formatTokens(stats.lifetimeTokensSaved)}
            </span>
          </div>
        </div>

        {stats.periods?.thisMonth && stats.periods.thisMonth.actualTokens > 0 ? (
          <div className="efficiency-period-note">
            This month: {formatTokens(stats.periods.thisMonth.tokensSaved)} saved
            ({stats.periods.thisMonth.efficiencyScore}% of estimated spend)
          </div>
        ) : null}

        <div className="efficiency-hero-sub">
          {stats.dataSource === "cached" ? (
            <>
              Based on {stats.breakdown.assistantTurnsAnalyzed.toLocaleString()} billed turns
              across {stats.breakdown.chatsAnalyzed.toLocaleString()} chats. Compares your
              actual API spend to an estimate of sending full history every turn — with
              Paprwork&apos;s context optimizations (truncation, summaries, memory, sync)
              working together.
            </>
          ) : isBackfilling ? (
            <>
              Backfilling stored footprints ({pendingTurns.toLocaleString()} turns remaining).
              Refresh shortly for final numbers.
            </>
          ) : (
            <>
              Based on {stats.breakdown.assistantTurnsAnalyzed.toLocaleString()} billed turns
              across {stats.breakdown.chatsAnalyzed.toLocaleString()} chats. Compares actual
              API spend to an estimate without Paprwork&apos;s combined context optimizations.
            </>
          )}
        </div>
      </div>

      <style>{`
        .efficiency-badge {
          color: #059669;
          background: rgba(5, 150, 105, 0.1);
        }

        .efficiency-usage-compare {
          padding: 12px;
          border-radius: 8px;
          background: var(--bg-secondary);
          margin-bottom: 10px;
        }

        .usage-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding: 6px 0;
        }

        .usage-row + .usage-row {
          border-top: 1px solid var(--border-subtle);
        }

        .saved-row {
          margin-top: 2px;
          padding-top: 10px;
        }

        .usage-label {
          font-size: 11px;
          color: var(--text-secondary);
        }

        .usage-value {
          font-size: 14px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }

        .usage-value.actual {
          color: var(--text-primary);
        }

        .usage-value.hypothetical {
          color: var(--text-tertiary);
          text-decoration: line-through;
          text-decoration-color: var(--text-tertiary);
        }

        .usage-value.saved {
          color: #059669;
          font-size: 18px;
        }

        .efficiency-hero-sub {
          font-size: 10px;
          color: var(--text-tertiary);
          line-height: 1.45;
        }

        .efficiency-period-note {
          font-size: 10px;
          color: var(--text-secondary);
          margin-bottom: 8px;
        }
      `}</style>
    </div>
  );
}
