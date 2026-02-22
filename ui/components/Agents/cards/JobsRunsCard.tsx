import React from "react";

interface SubAgentRun {
  id: string;
  agentId: string;
  agentName: string;
  taskId: string;
  sessionId: string;
  status: "pending" | "running" | "completed" | "failed";
  startTime: string;
  endTime?: string;
  result?: unknown;
  error?: string;
}

interface SubAgentProfile {
  id: string;
  name: string;
  runCount: number;
}

interface DashboardStats {
  totalAgents: number;
  totalRuns: number;
  successRate: number;
  averageDuration: number;
}

interface Props {
  runs: SubAgentRun[];
  agents: SubAgentProfile[];
  dashboard?: DashboardStats;
}

export function JobsRunsCard({ runs, agents, dashboard }: Props) {
  const totalRuns = dashboard?.totalRuns ?? runs.length;
  const completedRuns = runs.filter((r) => r.status === "completed").length;
  const failedRuns = runs.filter((r) => r.status === "failed").length;
  const activeRuns = runs.filter(
    (r) => r.status === "running" || r.status === "pending",
  ).length;
  const successRate = dashboard?.successRate
    ? Math.round(dashboard.successRate * 100)
    : totalRuns > 0
      ? Math.round((completedRuns / totalRuns) * 100)
      : 0;

  // Top agents by delegation count
  const agentsByRuns = agents
    .filter((agent) => agent.runCount > 0)
    .sort((a, b) => b.runCount - a.runCount)
    .slice(0, 5);

  const maxRuns = agentsByRuns[0]?.runCount ?? 1;

  // Recent job history
  const recentRuns = runs
    .sort(
      (a, b) =>
        new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
    )
    .slice(0, 3);

  return (
    <div className="metric-card">
      <div className="card-header">
        <div className="card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M3 3v18h18" stroke="currentColor" strokeWidth="2" />
            <path d="M7 13l4-4 3 3 4-4" stroke="currentColor" strokeWidth="2" />
          </svg>
          Jobs & Runs
        </div>
        <div className="card-badge">{successRate}% success</div>
      </div>

      <div className="card-content">
        {/* Stats Grid */}
        <div className="jobs-stats-grid">
          <div className="jobs-stat">
            <div className="jobs-stat-value">{totalRuns}</div>
            <div className="jobs-stat-label">Total</div>
          </div>
          <div className="jobs-stat">
            <div className="jobs-stat-value active">{activeRuns}</div>
            <div className="jobs-stat-label">Active</div>
          </div>
          <div className="jobs-stat">
            <div className="jobs-stat-value success">{completedRuns}</div>
            <div className="jobs-stat-label">Success</div>
          </div>
          <div className="jobs-stat">
            <div className="jobs-stat-value failed">{failedRuns}</div>
            <div className="jobs-stat-label">Failed</div>
          </div>
        </div>

        {/* Top Agents */}
        {agentsByRuns.length > 0 && (
          <div className="jobs-agents">
            <div className="jobs-agents-label">Top Agents by Delegations</div>
            <div className="jobs-agents-list">
              {agentsByRuns.map((agent) => {
                const percentage =
                  maxRuns > 0 ? (agent.runCount / maxRuns) * 100 : 0;
                return (
                  <div key={agent.id} className="jobs-agent-item">
                    <div className="jobs-agent-info">
                      <span className="jobs-agent-name">{agent.name}</span>
                      <span className="jobs-agent-count">{agent.runCount}</span>
                    </div>
                    <div className="jobs-agent-bar-container">
                      <div
                        className="jobs-agent-bar"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recent History */}
        {recentRuns.length > 0 && (
          <div className="jobs-history">
            <div className="jobs-history-label">Recent Activity</div>
            <div className="jobs-history-list">
              {recentRuns.map((run) => {
                const timeAgo = getTimeAgo(new Date(run.startTime));
                return (
                  <div key={run.id} className="jobs-history-item">
                    <div className={`jobs-status-dot ${run.status}`} />
                    <div className="jobs-history-info">
                      <div className="jobs-history-name">{run.agentName}</div>
                      <div className="jobs-history-time">{timeAgo}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .jobs-stats-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 12px;
          padding-bottom: 16px;
          border-bottom: 1px solid var(--border-color);
        }

        .jobs-stat {
          text-align: center;
        }

        .jobs-stat-value {
          font-size: 24px;
          font-weight: 700;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
          margin-bottom: 4px;
        }

        .jobs-stat-value.active {
          color: var(--primary-color);
        }

        .jobs-stat-value.success {
          color: #10b981;
        }

        .jobs-stat-value.failed {
          color: #ef4444;
        }

        .jobs-stat-label {
          font-size: 10px;
          color: var(--text-tertiary);
          text-transform: uppercase;
        }

        .jobs-agents {
          padding: 16px 0;
          border-bottom: 1px solid var(--border-color);
        }

        .jobs-agents-label {
          font-size: 11px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          margin-bottom: 12px;
        }

        .jobs-agents-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .jobs-agent-item {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .jobs-agent-info {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .jobs-agent-name {
          font-size: 12px;
          color: var(--text-secondary);
        }

        .jobs-agent-count {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }

        .jobs-agent-bar-container {
          height: 4px;
          background: var(--bg-secondary);
          border-radius: 2px;
          overflow: hidden;
        }

        .jobs-agent-bar {
          height: 100%;
          background: linear-gradient(90deg, #3b82f6, #06b6d4);
          transition: width 0.3s ease;
        }

        .jobs-history {
          padding-top: 16px;
        }

        .jobs-history-label {
          font-size: 11px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          margin-bottom: 12px;
        }

        .jobs-history-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .jobs-history-item {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .jobs-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .jobs-status-dot.completed {
          background: #10b981;
        }

        .jobs-status-dot.running,
        .jobs-status-dot.pending {
          background: var(--primary-color);
          animation: pulse 2s infinite;
        }

        .jobs-status-dot.failed {
          background: #ef4444;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .jobs-history-info {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex: 1;
        }

        .jobs-history-name {
          font-size: 12px;
          color: var(--text-secondary);
        }

        .jobs-history-time {
          font-size: 11px;
          color: var(--text-tertiary);
        }
      `}</style>
    </div>
  );
}

function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
