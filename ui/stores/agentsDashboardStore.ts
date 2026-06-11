import { create } from "zustand";
import { gateway } from "../src/lib/gateway";
import type { ContextEfficiencyStats } from "../components/Agents/cards/ContextEfficiencyCard";
import type { DailyUsageTrend } from "../components/Agents/cards/UsageTrendChart";
import {
  loadAgentStatsMap,
  type AgentStats,
} from "../utils/loadAgentStats";
import type { SubAgentProfile } from "../hooks/useSubAgents";

export interface CostStats {
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
  const empty: AgentStats = {
    totalMessages: 0,
    totalTokens: 0,
    totalCost: 0,
    toolCallsCount: 0,
    avgTokensPerMessage: 0,
    avgCostPerMessage: 0,
    mostUsedTools: [],
  };
  const merged = { ...stats };
  for (const [agentId, usage] of Object.entries(toolUsage)) {
    const existing = merged[agentId] ?? empty;
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
    console.error("[AgentsDashboard] Tool usage failed:", err);
  }
  return {};
}

interface RefreshOptions {
  silent?: boolean;
  trendsOnly?: boolean;
}

interface AgentsDashboardState {
  costStats: CostStats | null;
  agentStats: Record<string, AgentStats>;
  contextEfficiency: ContextEfficiencyStats | null;
  dailyTrends: DailyUsageTrend[] | null;
  trendRange: 7 | 30 | 90;
  trendsLoading: boolean;
  efficiencyLoading: boolean;
  hasLoaded: boolean;
  setTrendRange: (range: 7 | 30 | 90) => void;
  refresh: (agents: SubAgentProfile[], options?: RefreshOptions) => void;
}

let refreshGeneration = 0;
let efficiencyPollTimer: ReturnType<typeof setTimeout> | null = null;
let statsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let trendsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function clearEfficiencyPoll(): void {
  if (efficiencyPollTimer) {
    clearTimeout(efficiencyPollTimer);
    efficiencyPollTimer = null;
  }
}

function pollContextEfficiency(
  generation: number,
  attempt = 0,
  silent = false,
): void {
  void gateway
    .send("agent:get-context-efficiency")
    .then((response) => {
      if (generation !== refreshGeneration) return;
      if (response.success && response.data) {
        const data = response.data as ContextEfficiencyStats;
        useAgentsDashboardStore.setState({ contextEfficiency: data });
        if (data.breakdown.chatsAnalyzed > 0 || attempt >= 8) {
          useAgentsDashboardStore.setState({ efficiencyLoading: false });
          return;
        }
      }
      if (attempt < 8) {
        efficiencyPollTimer = setTimeout(
          () => pollContextEfficiency(generation, attempt + 1, silent),
          2000,
        );
      } else {
        useAgentsDashboardStore.setState({ efficiencyLoading: false });
      }
    })
    .catch((err) => {
      if (generation !== refreshGeneration) return;
      console.error("[AgentsDashboard] Context efficiency failed:", err);
      if (attempt < 8) {
        efficiencyPollTimer = setTimeout(
          () => pollContextEfficiency(generation, attempt + 1, silent),
          2000,
        );
      } else {
        useAgentsDashboardStore.setState({ efficiencyLoading: false });
      }
    });
}

export const useAgentsDashboardStore = create<AgentsDashboardState>(
  (set, get) => ({
    costStats: null,
    agentStats: {},
    contextEfficiency: null,
    dailyTrends: null,
    trendRange: 30,
    trendsLoading: false,
    efficiencyLoading: false,
    hasLoaded: false,

    setTrendRange: (range) => {
      set({ trendRange: range });
      get().refresh([], { silent: true, trendsOnly: true });
    },

    refresh: (agents, options) => {
      const silent = options?.silent ?? false;
      const trendsOnly = options?.trendsOnly ?? false;
      const generation = ++refreshGeneration;

      if (!silent && !get().hasLoaded) {
        set({ trendsLoading: true, efficiencyLoading: true });
      } else if (!trendsOnly && silent) {
        // Background refresh — keep showing cached data
      }

      if (!trendsOnly) {
        clearEfficiencyPoll();

        void gateway
          .send("agent:get-cost-stats")
          .then((response) => {
            if (generation !== refreshGeneration) return;
            if (response.success && response.data) {
              set({
                costStats: response.data as CostStats,
                hasLoaded: true,
              });
            } else {
              set({ costStats: EMPTY_COST_STATS, hasLoaded: true });
            }
          })
          .catch((err) => {
            if (generation !== refreshGeneration) return;
            console.error("[AgentsDashboard] Cost stats failed:", err);
            set({ costStats: EMPTY_COST_STATS, hasLoaded: true });
          });

        if (!silent && !get().contextEfficiency) {
          set({ efficiencyLoading: true });
        }
        pollContextEfficiency(generation, 0, silent);

        if (statsDebounceTimer) {
          clearTimeout(statsDebounceTimer);
        }
        statsDebounceTimer = setTimeout(() => {
          void loadAgentStatsMap(agents, (partialStats) => {
            if (generation !== refreshGeneration) return;
            set((state) => ({
              agentStats: { ...state.agentStats, ...partialStats },
            }));
          })
            .then(async (statsMap) => {
              if (generation !== refreshGeneration) return;
              const toolUsage = await fetchToolUsageByAgent();
              if (generation !== refreshGeneration) return;
              set({
                agentStats: mergeToolUsage(statsMap, toolUsage),
                hasLoaded: true,
              });
            })
            .catch((statsError) => {
              console.error(
                "[AgentsDashboard] Failed to load agent stats:",
                statsError,
              );
            });
        }, 400);
      }

      const { trendRange } = get();
      if (!silent || trendsOnly) {
        set({ trendsLoading: !get().dailyTrends });
      }
      if (trendsDebounceTimer) {
        clearTimeout(trendsDebounceTimer);
      }
      trendsDebounceTimer = setTimeout(() => {
        void gateway
          .send("agent:get-cost-trends", { days: trendRange })
          .then((response) => {
            if (generation !== refreshGeneration) return;
            if (response.success && Array.isArray(response.data)) {
              set({
                dailyTrends: (response.data as DailyUsageTrend[]).map(
                  (day) => ({
                    date: day.date,
                    cost: Number(day.cost ?? 0),
                    messages: Number(day.messages ?? 0),
                    tokens: Number(day.tokens ?? 0),
                  }),
                ),
                hasLoaded: true,
              });
            } else {
              set({ dailyTrends: [], hasLoaded: true });
            }
          })
          .catch((error) => {
            if (generation !== refreshGeneration) return;
            console.error(
              "[AgentsDashboard] Failed to load usage trends:",
              error,
            );
            set({ dailyTrends: [] });
          })
          .finally(() => {
            if (generation !== refreshGeneration) return;
            set({ trendsLoading: false });
          });
      }, trendsOnly ? 0 : 800);
    },
  }),
);
