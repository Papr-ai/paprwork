import React, { useEffect, useMemo, useRef } from "react";
import { useSubAgents } from "../../hooks/useSubAgents";
import { useTabs } from "../../hooks/useTabs";
import { useAgentsDashboardStore } from "../../stores/agentsDashboardStore";
import { useJobRunDashboardStore } from "../../stores/jobRunDashboardStore";
import { useSubAgentsStore } from "../../stores/subAgentsStore";
import { CostOverviewCard } from "./cards/CostOverviewCard";
import { UsageAndEfficiencyCard } from "./cards/UsageAndEfficiencyCard";
import { JobsRunsCard } from "./cards/JobsRunsCard";
import { AgentRosterCard } from "./cards/AgentRosterCard";
import { ActiveOperationsCard } from "./cards/ActiveOperationsCard";
import { ToolsSkillsCard } from "./cards/ToolsSkillsCard";
import { OutputsCard } from "./cards/OutputsCard";
import "./AgentsViewCards.css";

export function AgentsView() {
  const { agents, runs, loading, error } = useSubAgents();
  const { activeLeftTab, activeRightTab, getTab } = useTabs();
  const wasVisibleRef = useRef(false);
  const costStats = useAgentsDashboardStore((state) => state.costStats);
  const agentStats = useAgentsDashboardStore((state) => state.agentStats);
  const contextEfficiency = useAgentsDashboardStore(
    (state) => state.contextEfficiency,
  );
  const dailyTrends = useAgentsDashboardStore((state) => state.dailyTrends);
  const trendsLoading = useAgentsDashboardStore((state) => state.trendsLoading);
  const trendRange = useAgentsDashboardStore((state) => state.trendRange);
  const efficiencyLoading = useAgentsDashboardStore(
    (state) => state.efficiencyLoading,
  );
  const hasLoaded = useAgentsDashboardStore((state) => state.hasLoaded);
  const refresh = useAgentsDashboardStore((state) => state.refresh);
  const setTrendRange = useAgentsDashboardStore((state) => state.setTrendRange);

  const isTabVisible = useMemo(() => {
    const leftTab = activeLeftTab ? getTab(activeLeftTab) : null;
    const rightTab = activeRightTab ? getTab(activeRightTab) : null;
    return leftTab?.type === "agents" || rightTab?.type === "agents";
  }, [activeLeftTab, activeRightTab, getTab]);

  useEffect(() => {
    refresh(agents, { silent: hasLoaded });
  }, [agents, hasLoaded, refresh]);

  useEffect(() => {
    if (isTabVisible && !wasVisibleRef.current) {
      refresh(agents, { silent: true });
      void useSubAgentsStore.getState().ensureLoaded();
      void useJobRunDashboardStore.getState().loadDashboard({ silent: true });
    }
    wasVisibleRef.current = isTabVisible;
  }, [isTabVisible, agents, refresh]);

  const activeRuns = runs.filter(
    (run) => run.status === "running" || run.status === "pending",
  );
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
      {error && <div className="error-banner">{error}</div>}

      <div className="cards-grid">
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

        <JobsRunsCard />
        <OutputsCard />

        <ToolsSkillsCard agentStats={agentStats} />
        <ActiveOperationsCard activeRuns={activeRuns} agents={agents} />

        <AgentRosterCard agents={agents} agentStats={agentStats} runs={runs} />
      </div>
    </div>
  );
}
