import React, { useEffect, useState } from "react";
import { gateway } from "../../../src/lib/gateway";

interface AgentOutputs {
  documents: Array<{ id: string; title: string; createdAt: string }>;
  apps: Array<{ id: string; title: string; createdAt: string }>;
  plans: Array<{ planId: string; title: string; createdAt: string }>;
}

interface Props {
  agentId?: string;
}

export function OutputsCard({ agentId }: Props) {
  const [outputs, setOutputs] = useState<AgentOutputs | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadOutputs = async (): Promise<void> => {
      try {
        await gateway.waitForConnection();
        await new Promise((resolve) => setTimeout(resolve, 3500));
        if (cancelled) return;
        const response = await gateway.send("agent:get-outputs", { agentId });
        if (cancelled) return;
        if (response.success && response.data) {
          setOutputs(response.data as AgentOutputs);
        } else {
          setOutputs({ documents: [], apps: [], plans: [] });
        }
      } catch (error) {
        if (cancelled) return;
        console.error("[OutputsCard] Failed to load outputs:", error);
        setOutputs({ documents: [], apps: [], plans: [] });
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadOutputs();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (loading) {
    return (
      <div className="metric-card">
        <div className="card-header">
          <div className="card-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M13 2v7h7" stroke="currentColor" strokeWidth="2" />
            </svg>
            Outputs Created
          </div>
        </div>
        <div className="card-content">
          <div className="loading-message">Loading outputs...</div>
        </div>
      </div>
    );
  }

  if (!outputs) {
    return (
      <div className="metric-card">
        <div className="card-header">
          <div className="card-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M13 2v7h7" stroke="currentColor" strokeWidth="2" />
            </svg>
            Outputs Created
          </div>
        </div>
        <div className="card-content">
          <div className="empty-state">
            <div className="empty-text">No outputs available</div>
          </div>
        </div>
      </div>
    );
  }

  const documents = outputs.documents ?? [];
  const apps = outputs.apps ?? [];
  const plans = outputs.plans ?? [];
  const totalOutputs = documents.length + apps.length + plans.length;

  return (
    <div className="metric-card">
      <div className="card-header">
        <div className="card-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path d="M13 2v7h7" stroke="currentColor" strokeWidth="2" />
          </svg>
          Outputs Created
        </div>
        <div className="card-badge">{totalOutputs}</div>
      </div>

      <div className="card-content">
        {/* Stats Grid */}
        <div className="outputs-stats-grid">
          <div className="outputs-stat">
            <div className="outputs-stat-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path d="M13 2v7h7" stroke="currentColor" strokeWidth="2" />
              </svg>
            </div>
            <div className="outputs-stat-content">
              <div className="outputs-stat-value">{documents.length}</div>
              <div className="outputs-stat-label">Documents</div>
            </div>
          </div>

          <div className="outputs-stat">
            <div className="outputs-stat-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect
                  x="3"
                  y="3"
                  width="18"
                  height="18"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M9 9h6M9 13h6M9 17h4"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </div>
            <div className="outputs-stat-content">
              <div className="outputs-stat-value">{apps.length}</div>
              <div className="outputs-stat-label">Apps</div>
            </div>
          </div>

          <div className="outputs-stat">
            <div className="outputs-stat-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M9 12h6M9 16h6"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </div>
            <div className="outputs-stat-content">
              <div className="outputs-stat-value">{plans.length}</div>
              <div className="outputs-stat-label">Plans</div>
            </div>
          </div>
        </div>

        {/* Recent Outputs */}
        {totalOutputs > 0 && (
          <div className="outputs-recent">
            <div className="outputs-recent-label">Recent Outputs</div>
            <div className="outputs-recent-list">
              {/* Documents */}
              {documents.slice(0, 3).map((doc) => (
                <div key={`doc-${doc.id}`} className="output-item">
                  <div className="output-type-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <path
                        d="M13 2v7h7"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                    </svg>
                  </div>
                  <div className="output-info">
                    <div className="output-title">{doc.title}</div>
                    <div className="output-meta">
                      <span className="output-type">Document</span>
                      <span className="output-time">
                        {formatDate(doc.createdAt)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              {/* Apps */}
              {apps.slice(0, 3).map((app) => (
                <div key={`app-${app.id}`} className="output-item">
                  <div className="output-type-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <rect
                        x="3"
                        y="3"
                        width="18"
                        height="18"
                        rx="2"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <path
                        d="M9 9h6M9 13h6M9 17h4"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                    </svg>
                  </div>
                  <div className="output-info">
                    <div className="output-title">{app.title}</div>
                    <div className="output-meta">
                      <span className="output-type">App</span>
                      <span className="output-time">
                        {formatDate(app.createdAt)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              {/* Plans */}
              {plans.slice(0, 3).map((plan) => (
                <div key={`plan-${plan.planId}`} className="output-item">
                  <div className="output-type-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <path
                        d="M9 12h6M9 16h6"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                    </svg>
                  </div>
                  <div className="output-info">
                    <div className="output-title">{plan.title}</div>
                    <div className="output-meta">
                      <span className="output-type">Plan</span>
                      <span className="output-time">
                        {formatDate(plan.createdAt)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {totalOutputs === 0 && (
          <div className="empty-state">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              className="empty-icon"
            >
              <path
                d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M13 2v7h7" stroke="currentColor" strokeWidth="2" />
            </svg>
            <div className="empty-text">No outputs created yet</div>
          </div>
        )}
      </div>

      <style>{`
        .outputs-stats-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          padding-bottom: 16px;
          border-bottom: 1px solid var(--border-color);
        }

        .outputs-stat {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px;
          background: var(--bg-secondary);
          border-radius: 8px;
        }

        .outputs-stat-icon {
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--card-bg);
          border: 1px solid var(--border-color);
          border-radius: 8px;
          color: var(--primary-color);
          flex-shrink: 0;
        }

        .outputs-stat-content {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .outputs-stat-value {
          font-size: 20px;
          font-weight: 700;
          color: var(--text-primary);
          font-variant-numeric: tabular-nums;
        }

        .outputs-stat-label {
          font-size: 10px;
          color: var(--text-tertiary);
          text-transform: uppercase;
        }

        .outputs-recent {
          padding-top: 16px;
        }

        .outputs-recent-label {
          font-size: 11px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          margin-bottom: 12px;
        }

        .outputs-recent-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .output-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: 6px;
          transition: all 0.15s ease;
        }

        .output-item:hover {
          background: var(--bg-tertiary);
          border-color: var(--primary-color);
        }

        .output-type-icon {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--card-bg);
          border: 1px solid var(--border-color);
          border-radius: 6px;
          color: var(--text-tertiary);
          flex-shrink: 0;
        }

        .output-info {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
          flex: 1;
        }

        .output-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .output-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 10px;
          color: var(--text-tertiary);
        }

        .output-type {
          padding: 2px 6px;
          background: var(--bg-tertiary);
          border-radius: 4px;
        }

        .output-time {
          font-family: 'SF Mono', Monaco, monospace;
        }

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

        .loading-message {
          text-align: center;
          padding: 40px 20px;
          color: var(--text-secondary);
          font-size: 12px;
        }
      `}</style>
    </div>
  );
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
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
