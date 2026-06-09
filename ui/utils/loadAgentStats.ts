import { gateway } from "../src/lib/gateway";
import type { SubAgentProfile } from "../hooks/useSubAgents";

export interface AgentStats {
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  toolCallsCount: number;
  totalToolInvocations?: number;
  avgTokensPerMessage: number;
  avgCostPerMessage: number;
  mostUsedTools: Array<{ tool: string; count: number }>;
}

async function fetchStatsForAgent(
  agentId: string,
): Promise<AgentStats | null> {
  try {
    const response = await gateway.send("agent:get-agent-stats", { agentId });
    if (response.success && response.data) {
      return response.data as AgentStats;
    }
  } catch {
    // Ignore per-agent failures
  }
  return null;
}

/**
 * Load per-agent analytics for the dashboard.
 * Prefers the bulk endpoint; falls back to parallel per-agent calls when
 * the gateway hasn't been restarted yet (unknown message type).
 */
export async function loadAgentStatsMap(
  agents: SubAgentProfile[],
  onPartial?: (stats: Record<string, AgentStats>) => void,
): Promise<Record<string, AgentStats>> {
  try {
    const response = await gateway.send("agent:get-all-agent-stats");
    if (response.success && response.data) {
      const data = response.data as Record<string, AgentStats>;
      if (Object.keys(data).length > 0) {
        onPartial?.(data);
        return data;
      }
    }
  } catch {
    // Fall through to per-agent loading
  }

  const statsMap: Record<string, AgentStats> = {};

  // Pen/main-agent holds ~99% of usage — surface it immediately
  const mainStats = await fetchStatsForAgent("main-agent");
  if (mainStats) {
    statsMap["main-agent"] = mainStats;
    onPartial?.({ ...statsMap });
  }

  const specialistIds = agents
    .map((agent) => agent.id)
    .filter((agentId) => agentId !== "main-agent");
  if (specialistIds.length === 0) {
    return statsMap;
  }

  const results = await Promise.all(
    specialistIds.map(async (agentId) => {
      const stats = await fetchStatsForAgent(agentId);
      return stats ? ([agentId, stats] as const) : null;
    }),
  );

  for (const entry of results) {
    if (entry) {
      statsMap[entry[0]] = entry[1];
    }
  }

  onPartial?.({ ...statsMap });
  return statsMap;
}
