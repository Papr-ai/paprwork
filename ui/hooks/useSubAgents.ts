import { useCallback, useEffect } from "react";
import { gateway } from "../src/lib/gateway";
import {
  subscribeSubAgentsPolling,
  useSubAgentsStore,
} from "../stores/subAgentsStore";

export type SubAgentProvider = "anthropic" | "openai" | "google";
export type OutputMode = "natural" | "structured";
export type MemoryPolicy = "none" | "summary" | "full";

export interface SubAgentProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider?: SubAgentProvider;
  model?: string;
  allowedToolIds?: string[];
  assignedSkills?: string[];
  outputMode?: OutputMode;
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: MemoryPolicy;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt?: string;
}

export interface DelegationRun {
  id: string;
  agentId: string;
  agentName?: string;
  task: string;
  context?: string;
  status: "pending" | "running" | "completed" | "failed";
  reportChatId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface SubAgentDashboard {
  totalAgents: number;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  runningRuns: number;
  successRate: number;
  topAgents: Array<{
    agentId: string;
    runs: number;
    completed: number;
    failed: number;
    successRate: number;
  }>;
  recentRuns: DelegationRun[];
}

interface UpsertSubAgentInput {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider?: SubAgentProvider;
  model?: string;
  allowedToolIds?: string[];
  assignedSkills?: string[];
  outputMode?: OutputMode;
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: MemoryPolicy;
}

interface DelegateTaskInput {
  task: string;
  context?: string;
  useAgentId?: string;
  reportChatId?: string;
  background?: boolean;
}

export function useSubAgents() {
  const agents = useSubAgentsStore((state) => state.agents);
  const runs = useSubAgentsStore((state) => state.runs);
  const loading = useSubAgentsStore((state) => state.loading);
  const error = useSubAgentsStore((state) => state.error);
  const dashboard = useSubAgentsStore((state) => state.dashboard);
  const loadAgents = useSubAgentsStore((state) => state.loadAgents);
  const loadRuns = useSubAgentsStore((state) => state.loadRuns);
  const loadDashboard = useSubAgentsStore((state) => state.loadDashboard);
  const ensureLoaded = useSubAgentsStore((state) => state.ensureLoaded);
  const upsertAgentInList = useSubAgentsStore((state) => state.upsertAgentInList);
  const removeAgent = useSubAgentsStore((state) => state.removeAgent);
  const prependRun = useSubAgentsStore((state) => state.prependRun);
  const setError = useSubAgentsStore((state) => state.setError);

  useEffect(() => {
    void ensureLoaded();
    return subscribeSubAgentsPolling();
  }, [ensureLoaded]);

  const upsertAgent = useCallback(
    async (input: UpsertSubAgentInput) => {
      setError(null);
      const response = await gateway.send("subagent:upsert", input);
      const data = response.data as { agent?: SubAgentProfile };
      if (data.agent) {
        upsertAgentInList(data.agent);
      }
      return data.agent;
    },
    [setError, upsertAgentInList],
  );

  const deleteAgent = useCallback(
    async (agentId: string) => {
      setError(null);
      await gateway.send("subagent:delete", { agentId });
      removeAgent(agentId);
    },
    [removeAgent, setError],
  );

  const delegateTask = useCallback(
    async (input: DelegateTaskInput) => {
      setError(null);
      const response = await gateway.send("subagent:delegate", input);
      const data = response.data as { run?: DelegationRun };
      if (data.run) {
        prependRun(data.run);
      }
      return data.run;
    },
    [prependRun, setError],
  );

  return {
    agents,
    runs,
    loading,
    error,
    dashboard,
    loadAgents,
    loadRuns,
    loadDashboard,
    upsertAgent,
    deleteAgent,
    delegateTask,
  };
}
