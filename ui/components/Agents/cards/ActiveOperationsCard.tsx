import React from "react";

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

interface SubAgentProfile {
  id: string;
  name: string;
  description: string;
}

interface Props {
  activeRuns: SubAgentRun[];
  agents: SubAgentProfile[];
}

export function ActiveOperationsCard({ activeRuns, agents }: Props) {
  const agentsMap = new Map(agents.map((a) => [a.id, a]));

  return (
    <div className="metric-card">
      <div className="card-header">
        <div className="card-title">
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
          Active Operations
        </div>
        <div className="card-badge">{activeRuns.length}</div>
      </div>

      <div className="card-content">
        {activeRuns.length === 0 ? (
          <div className="empty-state">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              className="empty-icon"
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M9 12h6" stroke="currentColor" strokeWidth="2" />
            </svg>
            <div className="empty-text">
              No sub-agent delegations running — Pen and other main chat work
              won&apos;t appear here
            </div>
          </div>
        ) : (
          <div className="operations-list">
            {activeRuns.map((run) => {
              const agent = agentsMap.get(run.agentId);
              const duration = getDuration(
                new Date(run.startedAt ?? run.createdAt),
              );
              const isRunning = run.status === "running";

              return (
                <div key={run.id} className="operation-item">
                  <div className="operation-header">
                    <div className="operation-agent">
                      <div className={`operation-status ${run.status}`} />
                      <span className="operation-agent-name">
                        {run.agentName ?? agent?.name ?? run.agentId}
                      </span>
                    </div>
                    <div className="operation-duration">{duration}</div>
                  </div>

                  {agent?.description && (
                    <div className="operation-description">
                      {agent.description}
                    </div>
                  )}

                  <div className="operation-meta">
                    <span className="operation-session">
                      {run.id.slice(0, 8)}
                    </span>
                    {isRunning && (
                      <div className="operation-progress">
                        <div className="progress-bar">
                          <div className="progress-fill" />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style>{`
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px 20px;
          text-align: center;
        }

        .empty-icon {
          color: var(--text-tertiary);
          opacity: 0.5;
          margin-bottom: 12px;
        }

        .empty-text {
          font-size: 12px;
          color: var(--text-tertiary);
        }

        .operations-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .operation-item {
          padding: 12px;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .operation-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .operation-agent {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .operation-status {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .operation-status.running {
          background: var(--primary-color);
          animation: pulse 2s infinite;
        }

        .operation-status.pending {
          background: #f59e0b;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .operation-agent-name {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .operation-duration {
          font-size: 11px;
          color: var(--text-tertiary);
          font-family: 'SF Mono', Monaco, monospace;
        }

        .operation-description {
          font-size: 11px;
          color: var(--text-secondary);
          line-height: 1.4;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }

        .operation-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .operation-session {
          font-size: 10px;
          color: var(--text-tertiary);
          font-family: 'SF Mono', Monaco, monospace;
        }

        .operation-progress {
          flex: 1;
          max-width: 120px;
        }

        .progress-bar {
          height: 4px;
          background: var(--bg-tertiary);
          border-radius: 2px;
          overflow: hidden;
        }

        .progress-fill {
          height: 100%;
          width: 60%;
          background: var(--primary-color);
          animation: progress 2s ease-in-out infinite;
        }

        @keyframes progress {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(100%); }
          100% { transform: translateX(-100%); }
        }
      `}</style>
    </div>
  );
}

function getDuration(startTime: Date): string {
  const seconds = Math.floor((Date.now() - startTime.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
