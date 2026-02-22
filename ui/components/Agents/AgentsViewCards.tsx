import React, { useEffect, useState } from "react";
import { useSubAgents } from "../../hooks/useSubAgents";
import { gateway } from "../../src/lib/gateway";
import { CostOverviewCard } from "./cards/CostOverviewCard";
import { TokenUsageCard } from "./cards/TokenUsageCard";
import { JobsRunsCard } from "./cards/JobsRunsCard";
import { AgentRosterCard } from "./cards/AgentRosterCard";
import { ActiveOperationsCard } from "./cards/ActiveOperationsCard";
import { ToolsSkillsCard } from "./cards/ToolsSkillsCard";
import { OutputsCard } from "./cards/OutputsCard";
import "./AgentsViewCards.css";

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
      <div className="agents-dashboard">
        <div className="loading-state">Loading agents...</div>
      </div>
    );
  }

  return (
    <div className="agents-dashboard">
      {/* Compact Header Stats */}
      <div className="dashboard-header">
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
                <path
                  d="M9 11l3 3L22 4"
                  stroke="currentColor"
                  strokeWidth="2"
                />
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
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* Cards Grid */}
      <div className="cards-grid">
        {/* Row 1: Cost & Tokens */}
        <CostOverviewCard costStats={costStats} />
        <TokenUsageCard
          agents={agents}
          agentStats={agentStats}
          totalTokens={totalTokens}
        />

        {/* Row 2: Jobs & Outputs */}
        <JobsRunsCard runs={runs} agents={agents} dashboard={dashboard} />
        <OutputsCard />

        {/* Row 3: Agent Roster (full width) */}
        <AgentRosterCard agents={agents} agentStats={agentStats} runs={runs} />

        {/* Row 4: Tools & Active Ops */}
        <ToolsSkillsCard agentStats={agentStats} />
        <ActiveOperationsCard activeRuns={activeRuns} agents={agents} />
      </div>
    </div>
  );
}
