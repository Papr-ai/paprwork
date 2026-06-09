import React, { useEffect, useState } from "react";
import { useSubAgents } from "../../hooks/useSubAgents";
import { gateway } from "../../src/lib/gateway";
import {
  loadAgentStatsMap,
  type AgentStats,
} from "../../utils/loadAgentStats";
import { CostOverviewCard } from "./cards/CostOverviewCard";
import { UsageAndEfficiencyCard } from "./cards/UsageAndEfficiencyCard";
import { JobsRunsCard } from "./cards/JobsRunsCard";
import { AgentRosterCard } from "./cards/AgentRosterCard";
import { ActiveOperationsCard } from "./cards/ActiveOperationsCard";
import { ToolsSkillsCard } from "./cards/ToolsSkillsCard";
import { OutputsCard } from "./cards/OutputsCard";
import type { ContextEfficiencyStats } from "./cards/ContextEfficiencyCard";
import type { DailyUsageTrend } from "./cards/UsageTrendChart";
import "./AgentsViewCards.css";

interface CostStats {
  today: number;
  thisWeek: number;
  thisMonth: number;
  total: number;
  totalTokens: number;
  todayTokens: number;
  thisWeekTokens: number;
  thisMonthTokens: number;
  totalMessages: number;
  topModels: Array<{
    model: string;
    cost: number;
    tokens: number;
    count: number;
  }>;
}

const EMPTY_COST_STATS: CostStats = {
  today: 0,
  thisWeek: 0,
  thisMonth: 0,
  total: 0,
  totalTokens: 0,
  todayTokens: 0,
  thisWeekTokens: 0,
  thisMonthTokens: 0,
  totalMessages: 0,
  topModels: [],
};

const EMPTY_AGENT_STATS: AgentStats = {
  totalMessages: 0,
  totalTokens: 0,
  totalCost: 0,
  toolCallsCount: 0,
  avgTokensPerMessage: 0,
  avgCostPerMessage: 0,
  mostUsedTools: [],
};

function mergeToolUsage(
  stats: Record<string, AgentStats>,
  toolUsage: Record<
    string,
    {
      mostUsedTools: Array<{ tool: string; count: number }>;
      totalToolInvocations: number;
    }
  >,
): Record<string, AgentStats> {
  const merged = { ...stats };
  for (const [agentId, usage] of Object.entries(toolUsage)) {
    const existing = merged[agentId] ?? EMPTY_AGENT_STATS;
    merged[agentId] = {
      ...existing,
      mostUsedTools: usage.mostUsedTools,
      totalToolInvocations: usage.totalToolInvocations,
    };
  }
  return merged;
}

async function fetchToolUsageByAgent(): Promise<
  Record<
    string,
    {
      mostUsedTools: Array<{ tool: string; count: number }>;
      totalToolInvocations: number;
    }
  >
> {
  try {
    const response = await gateway.send("agent:get-tool-usage");
    if (response.success && response.data) {
      return response.data as Record<
        string,
        {
          mostUsedTools: Array<{ tool: string; count: number }>;
          totalToolInvocations: number;
        }
      >;
    }
  } catch (err) {
    console.error("[AgentsView] Tool usage failed:", err);
  }
  return {};
}

export function AgentsView() {
  const { agents, runs, loading, error, dashboard } = useSubAgents();
  const [costStats, setCostStats] = useState<CostStats | null>(null);
  const [agentStats, setAgentStats] = useState<Record<string, AgentStats>>({});
  const [contextEfficiency, setContextEfficiency] =
    useState<ContextEfficiencyStats | null>(null);
  const [dailyTrends, setDailyTrends] = useState<DailyUsageTrend[] | null>(
    null,
  );
  const [trendsLoading, setTrendsLoading] = useState(true);
  const [trendRange, setTrendRange] = useState<7 | 30 | 90>(30);
  const [efficiencyLoading, setEfficiencyLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void gateway
      .send("agent:get-cost-stats")
      .then((response) => {
        if (cancelled) return;
        if (response.success && response.data) {
          setCostStats(response.data as CostStats);
        } else {
          setCostStats(EMPTY_COST_STATS);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("[AgentsView] Cost stats failed:", err);
          setCostStats(EMPTY_COST_STATS);
        }
      });

    const pollEfficiency = (attempt = 0): void => {
      void gateway
        .send("agent:get-context-efficiency")
        .then((response) => {
          if (cancelled) return;
          if (response.success && response.data) {
            const data = response.data as ContextEfficiencyStats;
            setContextEfficiency(data);
            if (data.breakdown.chatsAnalyzed > 0 || attempt >= 8) {
              setEfficiencyLoading(false);
              return;
            }
          }
          if (attempt < 8) {
            window.setTimeout(() => pollEfficiency(attempt + 1), 2000);
          } else {
            setEfficiencyLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            console.error("[AgentsView] Context efficiency failed:", err);
            if (attempt < 8) {
              window.setTimeout(() => pollEfficiency(attempt + 1), 2000);
            } else {
              setEfficiencyLoading(false);
            }
          }
        });
    };

    pollEfficiency();

    const statsTimer = window.setTimeout(() => {
      void loadAgentStatsMap(agents, (partialStats) => {
        if (!cancelled) {
          setAgentStats((prev) => ({ ...prev, ...partialStats }));
        }
      })
        .then(async (statsMap) => {
          if (cancelled) return;
          const toolUsage = await fetchToolUsageByAgent();
          if (cancelled) return;
          setAgentStats(mergeToolUsage(statsMap, toolUsage));
        })
        .catch((statsError) => {
          console.error("[AgentsView] Failed to load agent stats:", statsError);
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(statsTimer);
      setEfficiencyLoading(true);
    };
  }, [agents]);

  useEffect(() => {
    let cancelled = false;
    setTrendsLoading(true);

    const trendsTimer = window.setTimeout(() => {
      void gateway
        .send("agent:get-cost-trends", { days: trendRange })
      .then((response) => {
        if (cancelled) return;
        if (response.success && Array.isArray(response.data)) {
          setDailyTrends(
            (response.data as DailyUsageTrend[]).map((day) => ({
              date: day.date,
              cost: Number(day.cost ?? 0),
              messages: Number(day.messages ?? 0),
              tokens: Number(day.tokens ?? 0),
            })),
          );
        } else {
          setDailyTrends([]);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("[AgentsView] Failed to load usage trends:", error);
          setDailyTrends([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTrendsLoading(false);
        }
      });
    }, 800);

    return () => {
      cancelled = true;
      window.clearTimeout(trendsTimer);
    };
  }, [trendRange]);

  const totalAgents = (dashboard?.totalAgents ?? agents.length) + 1;
  const totalRuns = dashboard?.totalRuns ?? runs.length;
  const activeRuns = runs.filter(
    (run) => run.status === "running" || run.status === "pending",
  );
  const avgScore = dashboard?.successRate
    ? Math.round(dashboard.successRate * 100)
    : 0;
  const agentStatsTokens = Object.values(agentStats).reduce(
    (sum, stats) => sum + stats.totalTokens,
    0,
  );
  const totalTokens = agentStatsTokens || costStats?.totalTokens || 0;

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
        {/* Row 1: Cost & Token usage (with savings) */}
        <CostOverviewCard
          costStats={costStats}
          efficiency={contextEfficiency}
          efficiencyLoading={efficiencyLoading}
          dailyTrends={dailyTrends}
          trendsLoading={trendsLoading}
          trendRange={trendRange}
          onTrendRangeChange={setTrendRange}
        />
        <UsageAndEfficiencyCard
          agents={agents}
          agentStats={agentStats}
          tokenStats={{
            totalTokens,
            todayTokens: costStats?.todayTokens ?? 0,
            thisWeekTokens: costStats?.thisWeekTokens ?? 0,
            thisMonthTokens: costStats?.thisMonthTokens ?? 0,
            totalMessages: costStats?.totalMessages ?? 0,
          }}
          topModels={costStats?.topModels ?? []}
          efficiency={contextEfficiency}
          efficiencyLoading={efficiencyLoading}
          dailyTrends={dailyTrends}
          trendsLoading={trendsLoading}
          trendRange={trendRange}
          onTrendRangeChange={setTrendRange}
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
