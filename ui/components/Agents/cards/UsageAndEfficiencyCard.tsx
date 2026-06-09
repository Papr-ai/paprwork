import React from "react";
import { MetricPeriodSummary } from "./MetricPeriodSummary";
import { SavingsCompare } from "./SavingsCompare";
import {
  UsageTrendChart,
  type DailyUsageTrend,
} from "./UsageTrendChart";
import type { ContextEfficiencyStats } from "./ContextEfficiencyCard";
import { ModelBreakdown, type ModelUsageRow } from "./ModelBreakdown";

interface AgentStats {
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  toolCallsCount: number;
  avgTokensPerMessage: number;
  avgCostPerMessage: number;
  mostUsedTools: Array<{ tool: string; count: number }>;
}

interface SubAgentProfile {
  id: string;
  name: string;
}

interface TokenPeriodStats {
  totalTokens: number;
  todayTokens: number;
  thisWeekTokens: number;
  thisMonthTokens: number;
  totalMessages: number;
}

interface Props {
  agents: SubAgentProfile[];
  agentStats: Record<string, AgentStats>;
  tokenStats: TokenPeriodStats;
  topModels?: ModelUsageRow[];
  efficiency: ContextEfficiencyStats | null;
  efficiencyLoading?: boolean;
  dailyTrends?: DailyUsageTrend[] | null;
  trendsLoading?: boolean;
  trendRange?: 7 | 30 | 90;
  onTrendRangeChange?: (days: 7 | 30 | 90) => void;
}

export function UsageAndEfficiencyCard({
  agents,
  agentStats,
  tokenStats,
  topModels = [],
  efficiency,
  efficiencyLoading = false,
  dailyTrends = null,
  trendsLoading = false,
  trendRange = 30,
  onTrendRangeChange,
}: Props) {
  const totalMessages = Object.values(agentStats).reduce(
    (sum, stats) => sum + stats.totalMessages,
    0,
  );
  const avgTokensPerMessage =
    totalMessages > 0 ? tokenStats.totalTokens / totalMessages : 0;

  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));

  const agentsByTokens = Object.entries(agentStats)
    .map(([agentId, stats]) => ({
      id: agentId,
      name:
        agentId === "main-agent"
          ? "Pen"
          : (agentNameById.get(agentId) ?? agentId),
      stats,
    }))
    .filter((item) => item.stats.totalTokens > 0)
    .sort((a, b) => b.stats.totalTokens - a.stats.totalTokens)
    .slice(0, 5);

  const pendingTurns = efficiency?.pendingFootprintTurns ?? 0;
  const showEfficiency =
    efficiency !== null &&
    (efficiency.breakdown.chatsAnalyzed > 0 || pendingTurns > 0) &&
    !efficiencyLoading;

  const efficiencyBadge =
    showEfficiency && efficiency.lifetimeTokensSaved > 0
      ? `${efficiency.efficiencyScore}% saved`
      : null;

  return (
    <div className="metric-card">
      <div className="card-header">
        <div className="card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="12"
              r="3"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M12 1v6m0 6v6M1 12h6m6 0h6"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          Token Usage
        </div>
        {efficiencyBadge ? (
          <div className="card-badge usage-saved-badge">{efficiencyBadge}</div>
        ) : null}
      </div>

      <div className="card-content">
        <MetricPeriodSummary
          label="Total tokens"
          total={tokenStats.totalTokens}
          sublabel={`${avgTokensPerMessage.toFixed(0)} avg per message`}
          periods={{
            today: tokenStats.todayTokens,
            thisWeek: tokenStats.thisWeekTokens,
            thisMonth: tokenStats.thisMonthTokens,
          }}
          format="tokens"
        />

        {showEfficiency ? (
          <SavingsCompare
            actual={efficiency.totalTokensConsumed}
            hypothetical={efficiency.hypotheticalTokensWithoutOptimizations}
            saved={efficiency.lifetimeTokensSaved}
            format="tokens"
            compact
          />
        ) : efficiencyLoading ? (
          <div className="usage-efficiency-loading">
            Computing token savings…
          </div>
        ) : null}

        <UsageTrendChart
          trends={dailyTrends}
          metric="tokens"
          loading={trendsLoading}
          range={trendRange}
          onRangeChange={onTrendRangeChange}
        />

        <ModelBreakdown
          models={topModels}
          total={tokenStats.totalTokens}
          metric="tokens"
        />

        {agentsByTokens.length > 0 ? (
          <div className="tokens-agents">
            <div className="agents-label">Top Agents</div>
            <div className="agents-list">
              {agentsByTokens.map(({ id, name, stats }) => {
                const percentage =
                  tokenStats.totalTokens > 0
                    ? (stats.totalTokens / tokenStats.totalTokens) * 100
                    : 0;
                const formatted =
                  stats.totalTokens > 1000
                    ? `${(stats.totalTokens / 1000).toFixed(1)}K`
                    : stats.totalTokens.toString();

                return (
                  <div key={id} className="agent-token-item">
                    <div className="agent-token-info">
                      <span className="agent-token-name">{name}</span>
                      <span className="agent-token-count">{formatted}</span>
                    </div>
                    <div className="agent-token-bar-container">
                      <div
                        className="agent-token-bar"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <style>{`
        .usage-saved-badge {
          color: #059669;
          background: rgba(5, 150, 105, 0.1);
        }

        .usage-efficiency-loading {
          font-size: 10px;
          color: var(--text-tertiary);
          margin-bottom: 8px;
        }

        .tokens-agents {
          padding-top: 12px;
          border-top: 1px solid var(--border-color);
        }

        .agents-label {
          font-size: 11px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          margin-bottom: 8px;
        }

        .agents-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .agent-token-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .agent-token-info {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .agent-token-name {
          font-size: 11px;
          color: var(--text-secondary);
        }

        .agent-token-count {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }

        .agent-token-bar-container {
          height: 3px;
          background: var(--bg-secondary);
          border-radius: 2px;
          overflow: hidden;
        }

        .agent-token-bar {
          height: 100%;
          background: linear-gradient(90deg, #6366f1, #8b5cf6);
          transition: width 0.3s ease;
        }
      `}</style>
    </div>
  );
}
