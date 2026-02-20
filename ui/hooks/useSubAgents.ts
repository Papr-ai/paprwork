import { useCallback, useEffect, useState } from "react";
import { gateway } from "../src/lib/gateway";

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
  const [agents, setAgents] = useState<SubAgentProfile[]>([]);
  const [runs, setRuns] = useState<DelegationRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<SubAgentDashboard | null>(null);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await gateway.send("subagent:list");
      const data = response.data as { agents?: SubAgentProfile[] };
      setAgents(data.agents ?? []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load sub-agents",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async () => {
    setError(null);
    try {
      const response = await gateway.send("subagent:runs", { limit: 100 });
      const data = response.data as { runs?: DelegationRun[] };
      setRuns(data.runs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runs");
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    setError(null);
    try {
      const response = await gateway.send("subagent:dashboard", { limit: 200 });
      setDashboard((response.data as SubAgentDashboard) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    }
  }, []);

  const upsertAgent = useCallback(async (input: UpsertSubAgentInput) => {
    setError(null);
    const response = await gateway.send("subagent:upsert", input);
    const data = response.data as { agent?: SubAgentProfile };
    if (data.agent) {
      setAgents((prev) => {
        const next = prev.filter((item) => item.id !== data.agent?.id);
        return [data.agent as SubAgentProfile, ...next];
      });
    }
    return data.agent;
  }, []);

  const deleteAgent = useCallback(async (agentId: string) => {
    setError(null);
    await gateway.send("subagent:delete", { agentId });
    setAgents((prev) => prev.filter((item) => item.id !== agentId));
  }, []);

  const delegateTask = useCallback(async (input: DelegateTaskInput) => {
    setError(null);
    const response = await gateway.send("subagent:delegate", input);
    const data = response.data as { run?: DelegationRun };
    if (data.run) {
      setRuns((prev) => [data.run as DelegationRun, ...prev]);
    }
    return data.run;
  }, []);

  useEffect(() => {
    void Promise.all([loadAgents(), loadRuns(), loadDashboard()]);
    const timer = setInterval(() => {
      void Promise.all([loadRuns(), loadDashboard()]);
    }, 15000);
    return () => clearInterval(timer);
  }, [loadAgents, loadRuns, loadDashboard]);

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
