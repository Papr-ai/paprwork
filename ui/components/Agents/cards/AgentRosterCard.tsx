import React, { useState } from "react";
import { AgentProfileModal } from "../AgentProfileModal";

interface AgentStats {
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  toolCallsCount: number;
  avgTokensPerMessage: number;
  avgCostPerMessage: number;
  mostUsedTools: Array<{ tool: string; count: number }>;
}

interface SubAgentProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  allowedToolIds?: string[];
  assignedSkills?: string[];
  outputMode?: string;
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  memoryPolicy?: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt?: string;
}

interface SubAgentRun {
  id: string;
  agentId: string;
  agentName?: string;
  task?: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface Props {
  agents: SubAgentProfile[];
  agentStats: Record<string, AgentStats>;
  runs: SubAgentRun[];
}

export function AgentRosterCard({ agents, agentStats, runs }: Props) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const getActiveCount = (agentId: string) => {
    return runs.filter(
      (r) =>
        r.agentId === agentId &&
        (r.status === "running" || r.status === "pending"),
    ).length;
  };

  return (
    <>
      <div className="metric-card full-width">
        <div className="card-header">
          <div className="card-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2" />
              <path
                d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"
                stroke="currentColor"
                strokeWidth="2"
              />
              <circle
                cx="17"
                cy="7"
                r="2"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M21 21v-1a3 3 0 00-3-3h-1"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
            Agent Roster
          </div>
          <div className="card-badge">{agents.length} agents</div>
        </div>

        <div className="card-content">
          <div className="roster-table">
            {/* Table Header */}
            <div className="roster-header">
              <div className="roster-col-agent">Agent</div>
              <div className="roster-col-tools">Tools</div>
              <div className="roster-col-skills">Skills</div>
              <div className="roster-col-messages">Messages</div>
              <div className="roster-col-tokens">Tokens</div>
              <div className="roster-col-cost">Cost</div>
              <div className="roster-col-active">Last Active</div>
            </div>

            {/* Table Body */}
            <div className="roster-body">
              {agents.map((agent) => {
                const stats = agentStats[agent.id];
                const activeCount = getActiveCount(agent.id);
                const toolCount = agent.allowedToolIds?.length ?? 0;
                const skillCount = agent.assignedSkills?.length ?? 0;

                return (
                  <div
                    key={agent.id}
                    className="roster-row"
                    onClick={() => setSelectedAgentId(agent.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <div className="roster-col-agent">
                    <div className="agent-avatar">{agent.name.charAt(0)}</div>
                    <div className="agent-info">
                      <div className="agent-name-row">
                        <span className="agent-name">{agent.name}</span>
                        {activeCount > 0 && (
                          <span className="agent-active-badge">
                            {activeCount}
                          </span>
                        )}
                      </div>
                      <div className="agent-model">
                        {agent.model ?? "gpt-5.4"}
                      </div>
                    </div>
                  </div>

                  <div className="roster-col-tools">
                    <div className="roster-badge">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <path
                          d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
                          stroke="currentColor"
                          strokeWidth="2"
                        />
                      </svg>
                      <span>{toolCount}</span>
                    </div>
                  </div>

                  <div className="roster-col-skills">
                    <div className="roster-badge">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <path
                          d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"
                          stroke="currentColor"
                          strokeWidth="2"
                        />
                        <path
                          d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"
                          stroke="currentColor"
                          strokeWidth="2"
                        />
                      </svg>
                      <span>{skillCount}</span>
                    </div>
                  </div>

                  <div className="roster-col-messages">
                    <span className="roster-value">
                      {stats?.totalMessages ?? 0}
                    </span>
                  </div>

                  <div className="roster-col-tokens">
                    <span className="roster-value">
                      {stats?.totalTokens
                        ? stats.totalTokens > 1000
                          ? `${(stats.totalTokens / 1000).toFixed(1)}K`
                          : stats.totalTokens
                        : "0"}
                    </span>
                  </div>

                  <div className="roster-col-cost">
                    <span className="roster-value">
                      $
                      {stats?.totalCost
                        ? stats.totalCost > 0.01
                          ? stats.totalCost.toFixed(2)
                          : stats.totalCost.toFixed(4)
                        : "0.00"}
                    </span>
                  </div>

                  <div className="roster-col-active">
                    <span className="roster-time">
                      {agent.lastRunAt
                        ? formatLastActive(new Date(agent.lastRunAt))
                        : "Never"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <style>{`
        .roster-table {
          display: flex;
          flex-direction: column;
        }

        .roster-header {
          display: grid;
          grid-template-columns: 2fr 100px 100px 100px 100px 100px 120px;
          gap: 12px;
          padding: 12px 16px;
          background: var(--bg-secondary);
          border-radius: 8px 8px 0 0;
          font-size: 10px;
          font-weight: 600;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .roster-body {
          display: flex;
          flex-direction: column;
          gap: 1px;
          background: var(--border-color);
        }

        .roster-row {
          display: grid;
          grid-template-columns: 2fr 100px 100px 100px 100px 100px 120px;
          gap: 12px;
          padding: 12px 16px;
          background: var(--card-bg);
          align-items: center;
          transition: background 0.15s ease;
        }

        .roster-row:hover {
          background: var(--bg-secondary);
        }

        .roster-col-agent {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .agent-avatar {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          background: linear-gradient(135deg, var(--primary-color), #8b5cf6);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          font-size: 14px;
          color: white;
          flex-shrink: 0;
        }

        .agent-info {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
        }

        .agent-name-row {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .agent-name {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .agent-active-badge {
          font-size: 10px;
          font-weight: 600;
          color: var(--primary-color);
          background: rgba(99, 102, 241, 0.15);
          padding: 2px 6px;
          border-radius: 4px;
          flex-shrink: 0;
        }

        .agent-model {
          font-size: 11px;
          color: var(--text-tertiary);
          font-family: 'SF Mono', Monaco, monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .roster-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 6px;
          font-size: 11px;
          color: var(--text-secondary);
          font-weight: 600;
        }

        .roster-badge svg {
          color: var(--text-tertiary);
        }

        .roster-value {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }

        .roster-time {
          font-size: 11px;
          color: var(--text-secondary);
        }

        @media (max-width: 1200px) {
          .roster-header,
          .roster-row {
            grid-template-columns: 2fr 80px 80px 80px 80px 80px 100px;
            gap: 8px;
            padding: 10px 12px;
          }

          .agent-avatar {
            width: 28px;
            height: 28px;
            font-size: 12px;
          }

          .roster-header {
            font-size: 9px;
          }
        }
      `}</style>
    </div>

    {selectedAgentId && (
      <AgentProfileModal
        agentId={selectedAgentId}
        onClose={() => setSelectedAgentId(null)}
      />
    )}
  </>
  );
}

function formatLastActive(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
