import React from "react";

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
}

export function TokenUsageCard({ agents, agentStats, totalTokens }: Props) {
  const totalMessages = Object.values(agentStats).reduce(
    (sum, stats) => sum + stats.totalMessages,
    0,
  );
  const avgTokensPerMessage =
    totalMessages > 0 ? totalTokens / totalMessages : 0;

  // Get top 5 agents by token usage
  const agentsByTokens = agents
    .map((agent) => ({
      agent,
      stats: agentStats[agent.id],
    }))
    .filter((item) => item.stats && item.stats.totalTokens > 0)
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
        <div className="card-badge">{totalMessages} msgs</div>
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

        {/* Top Agents by Tokens */}
        {agentsByTokens.length > 0 && (
          <div className="tokens-agents">
            <div className="agents-label">Top Agents</div>
            <div className="agents-list">
              {agentsByTokens.map(({ agent, stats }) => {
                const percentage =
                  totalTokens > 0 ? (stats.totalTokens / totalTokens) * 100 : 0;
                const formatted =
                  stats.totalTokens > 1000
                    ? `${(stats.totalTokens / 1000).toFixed(1)}K`
                    : stats.totalTokens.toString();

                return (
                  <div key={agent.id} className="agent-token-item">
                    <div className="agent-token-info">
                      <span className="agent-token-name">{agent.name}</span>
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

        {/* Token Efficiency */}
        {totalMessages > 0 && (
          <div className="token-efficiency">
            <div className="efficiency-item">
              <div className="efficiency-label">Efficiency Score</div>
              <div className="efficiency-value">
                {avgTokensPerMessage < 500
                  ? "High"
                  : avgTokensPerMessage < 1000
                    ? "Medium"
                    : "Low"}
              </div>
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

        .token-efficiency {
          padding: 12px;
          background: var(--bg-secondary);
          border-radius: 8px;
          margin-top: 12px;
        }

        .efficiency-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .efficiency-label {
          font-size: 11px;
          color: var(--text-tertiary);
          text-transform: uppercase;
        }

        .efficiency-value {
          font-size: 13px;
          font-weight: 600;
          color: var(--primary-color);
        }
      `}</style>
    </div>
  );
}
