import React, { useEffect, useState } from "react";
import { useSubAgents } from "../../hooks/useSubAgents";
import { gateway } from "../../src/lib/gateway";
import { AgentProfileModal } from "./AgentProfileModal";
import "./AgentsViewUnified.css";

interface AgentStats {
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  toolCallsCount: number;
  avgTokensPerMessage: number;
  avgCostPerMessage: number;
  mostUsedTools: Array<{ tool: string; count: number }>;
}

interface CostStats {
  today: number;
  thisWeek: number;
  thisMonth: number;
  total: number;
  totalMessages: number;
  topModels: Array<{ model: string; cost: number; count: number }>;
}

export function AgentsView() {
  const { agents, runs, loading, error, dashboard } = useSubAgents();
  const [costStats, setCostStats] = useState<CostStats | null>(null);
  const [agentStats, setAgentStats] = useState<Record<string, AgentStats>>({});
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  useEffect(() => {
    const loadData = async () => {
      try {
        const response = await gateway.send("agent:get-cost-stats");
        if (response.success && response.data) {
          setCostStats(response.data);
        }
      } catch (error) {
        console.error("[AgentsView] Failed to load cost stats:", error);
      }
    };
    void loadData();
  }, []);

  useEffect(() => {
    const loadAgentStats = async () => {
      const statsMap: Record<string, AgentStats> = {};
      for (const agent of agents) {
        try {
          const response = await gateway.send("agent:get-agent-stats", {
            agentId: agent.id,
          });
          if (response.success && response.data) {
            statsMap[agent.id] = response.data;
          }
        } catch (error) {
          console.error(
            `[AgentsView] Failed to load stats for ${agent.id}:`,
            error,
          );
        }
      }
      setAgentStats(statsMap);
    };

    if (agents.length > 0) {
      void loadAgentStats();
    }
  }, [agents]);

  const totalAgents = (dashboard?.totalAgents ?? agents.length) + 1;
  const totalRuns = dashboard?.totalRuns ?? runs.length;
  const activeRuns = runs.filter(
    (run) => run.status === "running" || run.status === "pending",
  );
  const avgScore = dashboard?.successRate
    ? Math.round(dashboard.successRate * 100)
    : 0;
  const totalTokens = Object.values(agentStats).reduce(
    (sum, stats) => sum + stats.totalTokens,
    0,
  );

  if (loading && agents.length === 0) {
    return (
      <div className="agents-unified">
        <div className="loading-state">Loading agents...</div>
      </div>
    );
  }

  return (
    <div className="agents-unified">
      {/* Compact Header Stats */}
      <div className="header-stats">
        <div className="stat-item">
          <div className="stat-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle
                cx="12"
                cy="8"
                r="4"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
          </div>
          <div className="stat-content">
            <div className="stat-label">AGENTS</div>
            <div className="stat-value">{totalAgents}</div>
          </div>
        </div>

        <div className="stat-item">
          <div className="stat-icon active">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="2" />
            </svg>
          </div>
          <div className="stat-content">
            <div className="stat-label">ACTIVE</div>
            <div className="stat-value active">{activeRuns.length}</div>
          </div>
        </div>

        <div className="stat-item">
          <div className="stat-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M3 3v18h18" stroke="currentColor" strokeWidth="2" />
              <path
                d="M7 13l4-4 3 3 4-4"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
          </div>
          <div className="stat-content">
            <div className="stat-label">TOTAL RUNS</div>
            <div className="stat-value">{totalRuns}</div>
          </div>
        </div>

        <div className="stat-item">
          <div className="stat-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M9 11l3 3L22 4" stroke="currentColor" strokeWidth="2" />
              <path
                d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
          </div>
          <div className="stat-content">
            <div className="stat-label">AVG SCORE</div>
            <div className="stat-value">{avgScore}%</div>
          </div>
        </div>

        <div className="stat-item">
          <div className="stat-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
          </div>
          <div className="stat-content">
            <div className="stat-label">TOTAL COST</div>
            <div className="stat-value">
              ${costStats?.total.toFixed(2) ?? "0.00"}
            </div>
          </div>
        </div>

        <div className="stat-item">
          <div className="stat-icon">
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
          </div>
          <div className="stat-content">
            <div className="stat-label">PENDING</div>
            <div className="stat-value">
              {runs.filter((r) => r.status === "pending").length}
            </div>
          </div>
        </div>
      </div>

      <div className="content-grid">
        {/* Main Agent Roster Table */}
        <div className="main-content">
          <div className="section-header">
            <h2>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle
                  cx="12"
                  cy="8"
                  r="4"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
              Agent Roster
            </h2>
            <span className="agent-count">{agents.length} agents</span>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="agent-table">
            <div className="table-header">
              <div className="col-agent">AGENT</div>
              <div className="col-runs">RUNS</div>
              <div className="col-tokens">TOKENS</div>
              <div className="col-score">AVG SCORE</div>
              <div className="col-trend">TREND</div>
              <div className="col-cost">COST</div>
              <div className="col-active">LAST ACTIVE</div>
            </div>

            <div className="table-body">
              {agents.map((agent) => {
                const stats = agentStats[agent.id];
                const agentRuns = runs.filter((r) => r.agentId === agent.id);
                const completedRuns = agentRuns.filter(
                  (r) => r.status === "completed",
                ).length;
                const score =
                  agentRuns.length > 0
                    ? Math.round((completedRuns / agentRuns.length) * 100)
                    : 0;
                const isActive = agentRuns.some((r) => r.status === "running");

                return (
                  <div
                    key={agent.id}
                    className={`table-row ${isActive ? "active" : ""}`}
                    onClick={() => setSelectedAgentId(agent.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <div className="col-agent">
                      <div className="agent-status" />
                      <div className="agent-icon">{agent.name.charAt(0)}</div>
                      <div className="agent-info">
                        <div className="agent-name">{agent.name}</div>
                        <div className="agent-model">
                          {agent.model ?? "gpt-5.4"}
                        </div>
                      </div>
                    </div>

                    <div className="col-runs">
                      <span className="runs-count">
                        {stats?.totalMessages ?? 0}
                      </span>
                    </div>

                    <div className="col-tokens">
                      <span className="tokens-count">
                        {stats?.totalTokens
                          ? stats.totalTokens > 1000
                            ? `${(stats.totalTokens / 1000).toFixed(1)}K`
                            : stats.totalTokens
                          : "0"}
                      </span>
                    </div>

                    <div className="col-score">
                      <div className="score-bar">
                        <div
                          className="score-fill"
                          style={{ width: `${score}%` }}
                          data-score={
                            score >= 70
                              ? "good"
                              : score >= 50
                                ? "medium"
                                : "low"
                          }
                        />
                      </div>
                      <span className="score-text">{score}%</span>
                    </div>

                    <div className="col-trend">
                      <svg
                        width="60"
                        height="24"
                        viewBox="0 0 60 24"
                        className="sparkline"
                      >
                        <path
                          d="M 0 20 L 10 18 L 20 15 L 30 14 L 40 16 L 50 12 L 60 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        />
                      </svg>
                    </div>

                    <div className="col-cost">
                      <span className="cost-value">
                        $
                        {stats?.totalCost
                          ? stats.totalCost > 0.01
                            ? stats.totalCost.toFixed(2)
                            : stats.totalCost.toFixed(4)
                          : "0.00"}
                      </span>
                    </div>

                    <div className="col-active">
                      <span className="last-active">
                        {agent.lastRunAt
                          ? new Date(agent.lastRunAt).toLocaleDateString(
                              "en-US",
                              { month: "short", day: "numeric" },
                            )
                          : "Never"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right Sidebar */}
        <div className="sidebar-content">
          {/* Active Operations */}
          {activeRuns.length > 0 && (
            <div className="sidebar-section">
              <div className="section-header-small">
                <h3>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                    <path
                      d="M12 6v6l4 2"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  </svg>
                  Active Operations
                </h3>
                <span className="count-badge">{activeRuns.length} running</span>
              </div>
              <div className="operations-list">
                {activeRuns.slice(0, 3).map((run) => {
                  const agent = agents.find((a) => a.id === run.agentId);
                  return (
                    <div key={run.id} className="operation-item">
                      <div className="op-indicator pulsing" />
                      <div className="op-content">
                        <div className="op-agent">
                          {agent?.name ?? "Unknown"}
                        </div>
                        <div className="op-task">
                          {(run.task ?? "").substring(0, 40)}...
                        </div>
                      </div>
                      <div className="op-time">
                        {new Date(
                          run.startedAt ?? run.createdAt,
                        ).toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Cost Breakdown */}
          {costStats && (costStats.topModels ?? []).length > 0 && (
            <div className="sidebar-section">
              <div className="section-header-small">
                <h3>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  </svg>
                  Cost Breakdown
                </h3>
                <span className="total-cost">
                  ${costStats.total.toFixed(2)} total
                </span>
              </div>
              <div className="cost-breakdown-list">
                {(costStats.topModels ?? []).slice(0, 5).map((model, idx) => {
                  const percentage =
                    costStats.total > 0
                      ? (model.cost / costStats.total) * 100
                      : 0;
                  return (
                    <div key={model.model} className="cost-item">
                      <div className="cost-model">
                        <div
                          className="model-dot"
                          style={{ background: `hsl(${idx * 60}, 70%, 50%)` }}
                        />
                        <span className="model-name">{model.model}</span>
                      </div>
                      <div className="cost-bar-container">
                        <div
                          className="cost-bar"
                          style={{
                            width: `${percentage}%`,
                            background: `hsl(${idx * 60}, 70%, 50%)`,
                          }}
                        />
                      </div>
                      <span className="cost-amount">
                        ${model.cost.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Quick Stats */}
          <div className="sidebar-section">
            <div className="section-header-small">
              <h3>Quick Stats</h3>
            </div>
            <div className="quick-stats-grid">
              <div className="quick-stat">
                <div className="quick-stat-value">
                  {totalTokens > 1000
                    ? `${(totalTokens / 1000).toFixed(1)}K`
                    : totalTokens}
                </div>
                <div className="quick-stat-label">Total Tokens</div>
              </div>
              <div className="quick-stat">
                <div className="quick-stat-value">
                  {costStats?.totalMessages ?? 0}
                </div>
                <div className="quick-stat-label">Messages</div>
              </div>
              <div className="quick-stat">
                <div className="quick-stat-value">
                  ${costStats?.thisMonth.toFixed(2) ?? "0.00"}
                </div>
                <div className="quick-stat-label">This Month</div>
              </div>
              <div className="quick-stat">
                <div className="quick-stat-value">
                  ${costStats?.today.toFixed(3) ?? "0.000"}
                </div>
                <div className="quick-stat-label">Today</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedAgentId && (
        <AgentProfileModal
          agentId={selectedAgentId}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  );
}
