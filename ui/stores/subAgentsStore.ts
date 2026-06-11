import { create } from "zustand";
import { gateway } from "../src/lib/gateway";
import type {
  DelegationRun,
  SubAgentDashboard,
  SubAgentProfile,
} from "../hooks/useSubAgents";

function parseRunsPayload(data: unknown): DelegationRun[] {
  if (Array.isArray(data)) {
    return data as DelegationRun[];
  }
  if (data && typeof data === "object" && "runs" in data) {
    const runs = (data as { runs?: unknown }).runs;
    return Array.isArray(runs) ? (runs as DelegationRun[]) : [];
  }
  return [];
}

interface SubAgentsState {
  agents: SubAgentProfile[];
  runs: DelegationRun[];
  dashboard: SubAgentDashboard | null;
  loading: boolean;
  error: string | null;
  hasLoaded: boolean;
  loadAgents: (options?: { silent?: boolean }) => Promise<void>;
  loadRuns: (options?: { silent?: boolean }) => Promise<void>;
  loadDashboard: (options?: { silent?: boolean }) => Promise<void>;
  ensureLoaded: () => Promise<void>;
  setAgents: (agents: SubAgentProfile[]) => void;
  prependRun: (run: DelegationRun) => void;
  removeAgent: (agentId: string) => void;
  upsertAgentInList: (agent: SubAgentProfile) => void;
  setError: (error: string | null) => void;
}

export const useSubAgentsStore = create<SubAgentsState>((set, get) => ({
  agents: [],
  runs: [],
  dashboard: null,
  loading: false,
  error: null,
  hasLoaded: false,

  setError: (error) => set({ error }),

  setAgents: (agents) => set({ agents }),

  prependRun: (run) =>
    set((state) => ({
      runs: [run, ...state.runs],
    })),

  removeAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.filter((item) => item.id !== agentId),
    })),

  upsertAgentInList: (agent) =>
    set((state) => {
      const next = state.agents.filter((item) => item.id !== agent.id);
      return { agents: [agent, ...next] };
    }),

  loadAgents: async (options) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      set({ loading: true, error: null });
    }
    try {
      const response = await gateway.send("subagent:list");
      const data = response.data as { agents?: SubAgentProfile[] };
      set({
        agents: data.agents ?? [],
        hasLoaded: true,
        error: null,
      });
    } catch (err) {
      if (!silent) {
        set({
          error:
            err instanceof Error ? err.message : "Failed to load sub-agents",
        });
      }
    } finally {
      if (!silent) {
        set({ loading: false });
      }
    }
  },

  loadRuns: async (options) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      set({ error: null });
    }
    try {
      const response = await gateway.send("subagent:runs", { limit: 100 });
      set({
        runs: parseRunsPayload(response.data),
        error: null,
      });
    } catch (err) {
      if (!silent) {
        set({
          error: err instanceof Error ? err.message : "Failed to load runs",
        });
      }
    }
  },

  loadDashboard: async (options) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      set({ error: null });
    }
    try {
      const response = await gateway.send("subagent:dashboard", { limit: 200 });
      set({
        dashboard: (response.data as SubAgentDashboard) ?? null,
        error: null,
      });
    } catch (err) {
      if (!silent) {
        set({
          error:
            err instanceof Error ? err.message : "Failed to load dashboard",
        });
      }
    }
  },

  ensureLoaded: async () => {
    const { hasLoaded, agents, loadAgents, loadRuns, loadDashboard } = get();
    const silent = hasLoaded || agents.length > 0;
    await Promise.all([
      loadAgents({ silent }),
      loadRuns({ silent }),
      loadDashboard({ silent }),
    ]);
  },
}));

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollSubscribers = 0;

export function subscribeSubAgentsPolling(): () => void {
  pollSubscribers += 1;
  if (pollSubscribers === 1) {
    pollTimer = setInterval(() => {
      const { loadRuns, loadDashboard } = useSubAgentsStore.getState();
      void loadRuns({ silent: true });
      void loadDashboard({ silent: true });
    }, 15_000);
  }

  return () => {
    pollSubscribers = Math.max(0, pollSubscribers - 1);
    if (pollSubscribers === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}
