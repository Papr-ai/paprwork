import React from "react";
import {
  UsageTrendChart,
  type DailyUsageTrend,
} from "./UsageTrendChart";

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
  description: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  allowedToolIds?: string[];
  assignedSkills?: string[];
  outputMode?: string;
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt?: string;
}

interface Props {
  agents: SubAgentProfile[];
  agentStats: Record<string, AgentStats>;
  totalTokens: number;
  dailyTrends?: DailyUsageTrend[] | null;
  trendsLoading?: boolean;
  trendRange?: 7 | 30 | 90;
  onTrendRangeChange?: (days: 7 | 30 | 90) => void;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function TokenUsageCard({
  agents,
  agentStats,
  totalTokens,
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
    totalMessages > 0 ? totalTokens / totalMessages : 0;

  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));

  // Include all agents with stats (main-agent = Pen holds most usage)
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
        <div className="card-badge">{formatTokens(totalTokens)} tokens</div>
      </div>

      <div className="card-content">
        {/* Total Tokens */}
        <div className="tokens-total">
          <div className="tokens-label">Total Tokens</div>
          <div className="tokens-value-large">
            {totalTokens > 1000000
              ? `${(totalTokens / 1000000).toFixed(2)}M`
              : totalTokens > 1000
                ? `${(totalTokens / 1000).toFixed(1)}K`
                : totalTokens}
          </div>
          <div className="tokens-sublabel">
            {avgTokensPerMessage.toFixed(0)} avg per message
          </div>
        </div>

        <UsageTrendChart
          trends={dailyTrends}
          metric="tokens"
          loading={trendsLoading}
          range={trendRange}
          onRangeChange={onTrendRangeChange}
        />

        {/* Top Agents by Tokens */}
        {agentsByTokens.length > 0 && (
          <div className="tokens-agents">
            <div className="agents-label">Top Agents</div>
            <div className="agents-list">
              {agentsByTokens.map(({ id, name, stats }) => {
                const percentage =
                  totalTokens > 0 ? (stats.totalTokens / totalTokens) * 100 : 0;
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
        )}

      </div>

      <style>{`
        .tokens-total {
          text-align: center;
          padding: 16px 0;
        }

        .tokens-label {
          font-size: 11px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }

        .tokens-value-large {
          font-size: 36px;
          font-weight: 700;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }

        .tokens-sublabel {
          font-size: 11px;
          color: var(--text-secondary);
          margin-top: 4px;
        }

        .tokens-agents {
          padding: 16px 0;
          border-top: 1px solid var(--border-color);
        }

        .agents-label {
          font-size: 11px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          margin-bottom: 12px;
        }

        .agents-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .agent-token-item {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .agent-token-info {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .agent-token-name {
          font-size: 12px;
          color: var(--text-secondary);
        }

        .agent-token-count {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }

        .agent-token-bar-container {
          height: 4px;
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
