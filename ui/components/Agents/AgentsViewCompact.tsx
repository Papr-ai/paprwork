import React, { useEffect, useMemo, useState } from "react";
import { useSubAgents, type SubAgentProfile } from "../../hooks/useSubAgents";
import { gateway } from "../../src/lib/gateway";
import { useTabStore } from "../../stores/tabStore";
import { CHAT_MODELS } from "../../constants/models";
import { CostTrends } from "./CostTrends";
import "./AgentsViewCompact.css";

// Subset of models for compact view (excludes openai-codex)
const COMPACT_MODEL_IDS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "gpt-5.2-low",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];
const modelOptions = CHAT_MODELS.filter((m) =>
  COMPACT_MODEL_IDS.includes(m.id),
).map((m) => m.id);

interface AgentStats {
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  toolCallsCount: number;
  avgTokensPerMessage: number;
  avgCostPerMessage: number;
  mostUsedTools: Array<{ tool: string; count: number }>;
}

export function AgentsView() {
  const {
    agents,
    runs,
    loading,
    error,
    dashboard,
    loadDashboard,
    loadRuns,
    upsertAgent,
    deleteAgent,
  } = useSubAgents();

  const [costStats, setCostStats] = useState<{
    today: number;
    thisWeek: number;
    thisMonth: number;
    total: number;
    totalMessages: number;
    topModels: Array<{ model: string; cost: number; count: number }>;
  } | null>(null);

  const [agentStats, setAgentStats] = useState<Record<string, AgentStats>>({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [expandedView, setExpandedView] = useState<"overview" | "trends">(
    "overview",
  );

  const { createTab, switchToTab } = useTabStore();

  // Load cost stats
  useEffect(() => {
    const loadCostStats = async () => {
      try {
        const response = await gateway.send("agent:get-cost-stats");
        if (response.success && response.data) {
          setCostStats(response.data);
        }
      } catch (error) {
        console.error("[AgentsView] Failed to load cost stats:", error);
      }
    };
    void loadCostStats();
  }, []);

  // Load stats for each agent
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
  const runningRuns =
    dashboard?.runningRuns ??
    runs.filter((run) => run.status === "running").length;

  const activeRuns = useMemo(
    () =>
      runs.filter(
        (run) => run.status === "running" || run.status === "pending",
      ),
    [runs],
  );

  if (loading && agents.length === 0) {
    return (
      <div className="agents-page-compact">
        <div
          style={{
            padding: "40px",
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
        >
          Loading agents...
        </div>
      </div>
    );
  }

  return (
    <div className="agents-page-compact">
      {/* Header with toggle */}
      <div className="agents-header-compact">
        <div>
          <h1>Agents</h1>
          <p className="page-subtitle">AI workforce and analytics</p>
        </div>
        <div className="view-toggle">
          <button
            className={`toggle-btn ${expandedView === "overview" ? "active" : ""}`}
            onClick={() => setExpandedView("overview")}
          >
            Overview
          </button>
          <button
            className={`toggle-btn ${expandedView === "trends" ? "active" : ""}`}
            onClick={() => setExpandedView("trends")}
          >
            Trends
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {expandedView === "overview" ? (
        <>
          {/* Compact Stats Bar */}
          <div className="stats-bar-compact">
            <div className="stat-item-compact">
              <div className="stat-icon-svg">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
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
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div>
                <div className="stat-value">{totalAgents}</div>
                <div className="stat-label">Agents</div>
              </div>
            </div>
            <div className="stat-item-compact">
              <div className="stat-icon-svg">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M8 12l3 3 5-5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <div className="stat-value">{runningRuns}</div>
                <div className="stat-label">Active</div>
              </div>
            </div>
            <div className="stat-item-compact">
              <div className="stat-icon-svg">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M3 3v18h18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M18 17l-5-5-4 4-3-3"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <div className="stat-value">{totalRuns}</div>
                <div className="stat-label">Total Runs</div>
              </div>
            </div>
            <div className="stat-item-compact">
              <div className="stat-icon-svg">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <div className="stat-value">
                  ${costStats?.total.toFixed(2) ?? "0.00"}
                </div>
                <div className="stat-label">Total Cost</div>
              </div>
            </div>
            <div className="stat-item-compact">
              <div className="stat-icon-svg">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div>
                <div className="stat-value">
                  {costStats?.totalMessages ?? 0}
                </div>
                <div className="stat-label">Messages</div>
              </div>
            </div>
          </div>

          {/* Active Jobs */}
          {activeRuns.length > 0 && (
            <div className="active-jobs-section">
              <h3>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  style={{
                    display: "inline-block",
                    verticalAlign: "middle",
                    marginRight: "8px",
                  }}
                >
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
                    strokeLinecap="round"
                  />
                </svg>
                Active Delegations ({activeRuns.length})
              </h3>
              <div className="active-jobs-list">
                {activeRuns.map((run) => {
                  const agent = agents.find((a) => a.id === run.agentId);
                  return (
                    <div key={run.id} className="active-job-card">
                      <div
                        className="job-status-indicator"
                        data-status={run.status}
                      />
                      <div className="job-info">
                        <div className="job-agent-name">
                          {agent?.name ?? "Unknown Agent"}
                        </div>
                        <div className="job-task">{run.task}</div>
                        <div className="job-time">
                          Started{" "}
                          {new Date(
                            run.startedAt ?? run.createdAt,
                          ).toLocaleTimeString()}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Agent Cards - Compact Grid */}
          <div className="agents-grid-compact">
            {agents.map((agent) => {
              const stats = agentStats[agent.id];
              const agentRuns = runs.filter((r) => r.agentId === agent.id);
              const activeCount = agentRuns.filter(
                (r) => r.status === "running" || r.status === "pending",
              ).length;

              return (
                <div key={agent.id} className="agent-card-compact">
                  <div className="agent-card-header">
                    <div className="agent-name">{agent.name}</div>
                    {activeCount > 0 && (
                      <div className="agent-active-badge">
                        {activeCount} active
                      </div>
                    )}
                  </div>

                  <div className="agent-description">{agent.description}</div>

                  {/* Stats Grid */}
                  {stats && (
                    <div className="agent-stats-grid">
                      <div className="agent-stat">
                        <div className="stat-label-small">Messages</div>
                        <div className="stat-value-small">
                          {stats.totalMessages}
                        </div>
                      </div>
                      <div className="agent-stat">
                        <div className="stat-label-small">Tokens</div>
                        <div className="stat-value-small">
                          {stats.totalTokens > 1000
                            ? `${(stats.totalTokens / 1000).toFixed(1)}K`
                            : stats.totalTokens}
                        </div>
                      </div>
                      <div className="agent-stat">
                        <div className="stat-label-small">Cost</div>
                        <div className="stat-value-small">
                          $
                          {stats.totalCost > 0.01
                            ? stats.totalCost.toFixed(2)
                            : stats.totalCost.toFixed(4)}
                        </div>
                      </div>
                      <div className="agent-stat">
                        <div className="stat-label-small">Tool Calls</div>
                        <div className="stat-value-small">
                          {stats.toolCallsCount}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Top Tools */}
                  {stats && (stats.mostUsedTools ?? []).length > 0 && (
                    <div className="agent-tools">
                      <div className="tools-label">Top Tools:</div>
                      <div className="tools-list">
                        {(stats.mostUsedTools ?? []).slice(0, 3).map((tool) => (
                          <span key={tool.tool} className="tool-badge">
                            {tool.tool} ({tool.count})
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Model */}
                  <div className="agent-model-row">
                    <span className="model-label">Model:</span>
                    <span className="model-value">
                      {agent.model ?? "gpt-5.2"}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="agent-actions">
                    <button
                      className="btn-agent-action"
                      onClick={() => {
                        // Open agent details or edit modal
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn-agent-action danger"
                      onClick={() => {
                        if (confirm(`Delete agent "${agent.name}"?`)) {
                          void deleteAgent(agent.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <CostTrends />
      )}
    </div>
  );
}
