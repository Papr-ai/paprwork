import React from "react";
import { useJobRunDashboard } from "../../../hooks/useJobRunDashboard";
import { openJobInJobsTab } from "../../../stores/jobNavigationStore";

export function JobsRunsCard() {
  const { dashboard, loading } = useJobRunDashboard();

  const totalJobs = dashboard?.totalJobs ?? 0;
  const activeJobs = dashboard?.activeJobs ?? 0;
  const completedRuns = dashboard?.completedRuns ?? 0;
  const failedRuns = dashboard?.failedRuns ?? 0;
  const successRate = dashboard
    ? Math.round(dashboard.successRate * 100)
    : 0;

  const topJobs = dashboard?.topJobs ?? [];
  const maxRuns = topJobs[0]?.runs ?? 1;
  const recentRuns = dashboard?.recentRuns ?? [];

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
        <div className="card-badge">
          {loading ? "…" : `${successRate}% success`}
        </div>
      </div>

      <div className="card-content">
        <div className="jobs-stats-grid">
          <div className="jobs-stat">
            <div className="jobs-stat-value">{loading ? "—" : totalJobs}</div>
            <div className="jobs-stat-label">Jobs</div>
          </div>
          <div className="jobs-stat">
            <div className="jobs-stat-value active">
              {loading ? "—" : activeJobs}
            </div>
            <div className="jobs-stat-label">Active</div>
          </div>
          <div className="jobs-stat">
            <div className="jobs-stat-value success">
              {loading ? "—" : completedRuns}
            </div>
            <div className="jobs-stat-label">Success</div>
          </div>
          <div className="jobs-stat">
            <div className="jobs-stat-value failed">
              {loading ? "—" : failedRuns}
            </div>
            <div className="jobs-stat-label">Failed</div>
          </div>
        </div>

        {topJobs.length > 0 && (
          <div className="jobs-agents">
            <div className="jobs-agents-label">Top Jobs by Runs</div>
            <div className="jobs-agents-list">
              {topJobs.map((job) => {
                const percentage =
                  maxRuns > 0 ? (job.runs / maxRuns) * 100 : 0;
                return (
                  <button
                    key={job.jobId}
                    type="button"
                    className="jobs-agent-item jobs-agent-item--clickable"
                    onClick={() => openJobInJobsTab(job.jobId)}
                    title={`Open ${job.jobName} in Jobs`}
                  >
                    <div className="jobs-agent-info">
                      <span className="jobs-agent-name">{job.jobName}</span>
                      <span className="jobs-agent-count">{job.runs}</span>
                    </div>
                    <div className="jobs-agent-bar-container">
                      <div
                        className="jobs-agent-bar"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {recentRuns.length > 0 && (
          <div className="jobs-history">
            <div className="jobs-history-label">Recent Runs</div>
            <div className="jobs-history-list">
              {recentRuns.map((run) => {
                const timeAgo = getTimeAgo(new Date(run.startedAt));
                const isNavigable =
                  run.status === "completed" || run.status === "failed";
                if (!isNavigable) {
                  return (
                    <div key={run.runId} className="jobs-history-item">
                      <div className={`jobs-status-dot ${run.status}`} />
                      <div className="jobs-history-info">
                        <div className="jobs-history-name">{run.jobName}</div>
                        <div className="jobs-history-time">{timeAgo}</div>
                      </div>
                    </div>
                  );
                }
                return (
                  <button
                    key={run.runId}
                    type="button"
                    className="jobs-history-item jobs-history-item--clickable"
                    onClick={() => openJobInJobsTab(run.jobId)}
                    title={`Open ${run.jobName} in Jobs`}
                  >
                    <div className={`jobs-status-dot ${run.status}`} />
                    <div className="jobs-history-info">
                      <div className="jobs-history-name">{run.jobName}</div>
                      <div className="jobs-history-time">{timeAgo}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {!loading && totalJobs === 0 && recentRuns.length === 0 && (
          <div className="jobs-empty">No jobs yet — create one from chat or the Jobs tab.</div>
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

        .jobs-agent-item--clickable {
          width: 100%;
          padding: 0;
          border: none;
          background: transparent;
          text-align: left;
          cursor: pointer;
          border-radius: 6px;
          transition: background 0.15s ease;
        }

        .jobs-agent-item--clickable:hover {
          background: var(--bg-secondary);
        }

        .jobs-agent-info {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .jobs-agent-name {
          font-size: 12px;
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 70%;
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

        .jobs-history-item--clickable {
          width: 100%;
          padding: 6px 4px;
          margin: -6px -4px;
          border: none;
          background: transparent;
          text-align: left;
          cursor: pointer;
          border-radius: 6px;
          transition: background 0.15s ease;
        }

        .jobs-history-item--clickable:hover {
          background: var(--bg-secondary);
        }

        .jobs-history-item--clickable:hover .jobs-history-name {
          color: var(--primary-color);
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

        .jobs-status-dot.cancelled {
          background: var(--text-tertiary);
        }

        .jobs-status-dot.failed {
          background: #ef4444;
        }

        .jobs-history-info {
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex: 1;
          min-width: 0;
        }

        .jobs-history-name {
          font-size: 12px;
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .jobs-history-time {
          font-size: 11px;
          color: var(--text-tertiary);
          flex-shrink: 0;
          margin-left: 8px;
        }

        .jobs-empty {
          padding-top: 12px;
          font-size: 12px;
          color: var(--text-tertiary);
          text-align: center;
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
