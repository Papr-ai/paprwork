import { useMemo, useState } from "react";
import { useJobs } from "../../hooks/useJobs";
import "./JobsView.css";

type JobFilter = "all" | "running" | "idle" | "scheduled" | "disabled";

export function JobsView() {
  const { jobs, loading, error, runJob, stopJob, loadLogs, logs } = useJobs();
  const [currentFilter, setCurrentFilter] = useState<JobFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set());

  const runningCount = jobs.filter((job) => job.status === "running").length;
  const idleCount = jobs.filter((job) => job.status !== "running").length;
  const scheduledCount = jobs.filter((job) => job.schedule?.enabled).length;

  const filteredJobs = useMemo(() => {
    const sorted = [...jobs].sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (a.status !== "running" && b.status === "running") return 1;
      return a.name.localeCompare(b.name);
    });

    return sorted.filter((job) => {
      if (currentFilter === "running" && job.status !== "running") return false;
      if (currentFilter === "idle" && job.status === "running") return false;
      if (currentFilter === "scheduled" && !job.schedule?.enabled) return false;
      if (currentFilter === "disabled") return false;
      if (!searchQuery.trim()) return true;
      const haystack = `${job.name} ${job.type} ${job.command ?? ""}`.toLowerCase();
      return haystack.includes(searchQuery.toLowerCase());
    });
  }, [jobs, currentFilter, searchQuery]);

  const toggleDetails = (jobId: string) => {
    setExpandedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const formatRelativeTime = (isoString?: string): string => {
    if (!isoString) return "Never";
    const date = new Date(isoString);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (seconds < 60) return "Just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return `${Math.floor(seconds / 604800)}w ago`;
  };

  const scheduleLabel = (job: { schedule?: { cron?: string; intervalMs?: number; atTime?: string } }): string => {
    const schedule = job.schedule;
    if (!schedule) return "Manual";
    if (schedule.cron) return "Scheduled";
    if (schedule.intervalMs) return `Every ${schedule.intervalMs}ms`;
    if (schedule.atTime) return `At ${schedule.atTime}`;
    return "Scheduled";
  };

  return (
    <div className="jobs-page-native">
      <div className="jobs-header-native">
        <div className="jobs-header-left">
          <h1>Background Jobs</h1>
          <p className="jobs-subtitle">Manage scheduled tasks and background processes</p>
        </div>
        <div className="jobs-header-right">
          <div className="jobs-stats">
            <div className="job-stat">
              <span className="jobs-stat-value">{runningCount}</span>
              <span className="jobs-stat-label">Running</span>
            </div>
            <div className="job-stat">
              <span className="jobs-stat-value">{idleCount}</span>
              <span className="jobs-stat-label">Idle</span>
            </div>
            <div className="job-stat">
              <span className="jobs-stat-value">{scheduledCount}</span>
              <span className="jobs-stat-label">Scheduled</span>
            </div>
          </div>
        </div>
      </div>

      <div className="jobs-filters">
        <div className="filter-tabs">
          {(["all", "running", "idle", "scheduled", "disabled"] as JobFilter[]).map((filter) => (
            <button
              key={filter}
              className={currentFilter === filter ? "filter-tab active" : "filter-tab"}
              onClick={() => setCurrentFilter(filter)}
            >
              {filter === "all" ? "All Jobs" : filter.charAt(0).toUpperCase() + filter.slice(1)}
            </button>
          ))}
        </div>
        <div className="filter-right">
          <div className="filter-search">
            <input
              id="jobs-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search jobs..."
            />
          </div>
        </div>
      </div>

      <div className="jobs-content-native">
        <div className="jobs-list-native">
          {loading && <p className="jobs-loading">Loading jobs...</p>}
          {error && <p className="jobs-loading">{error}</p>}

          {!loading && filteredJobs.length === 0 && (
            <div className="jobs-empty-state">
              <h3>No Matching Jobs</h3>
              <p>Try adjusting your filters or search</p>
            </div>
          )}

          {filteredJobs.map((job) => {
            const isRunning = job.status === "running";
            const isExpanded = expandedJobIds.has(job.id);
            const dependencies = job.dependsOn ?? [];
            return (
              <div className="job-card" key={job.id}>
                <div className="job-card-header" onClick={() => toggleDetails(job.id)}>
                  <div className="job-card-main">
                    <div className="job-title-row">
                      <div className={isRunning ? "job-status-indicator status-running" : "job-status-indicator status-idle"}>
                        <svg width="10" height="10" viewBox="0 0 10 10">
                          <circle cx="5" cy="5" r="3" fill="currentColor" />
                        </svg>
                      </div>
                      <h3 className="job-title">{job.name}</h3>
                      <span className="job-type-badge">{job.type}</span>
                      {job.schedule?.enabled && <span className="job-schedule-badge">{scheduleLabel(job)}</span>}
                      {dependencies.length > 0 && <span className="job-trigger-badge">Triggered</span>}
                    </div>
                    {job.command && <p className="job-description">{job.command}</p>}
                  </div>
                  <div className="job-card-actions" onClick={(event) => event.stopPropagation()}>
                    {isRunning ? (
                      <button
                        className="btn-job-action btn-job-delete"
                        title="Stop Job"
                        onClick={() => void stopJob(job.id)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <rect x="6" y="6" width="12" height="12" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        className="btn-job-action btn-job-test"
                        title="Test Job (Run Once)"
                        onClick={() => void runJob(job.id)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <path d="M8 5v14l11-7-11-7z" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </button>
                    )}
                    <button className={isExpanded ? "btn-job-action btn-job-expand expanded" : "btn-job-action btn-job-expand"}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <polyline points="6 9 12 15 18 9" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="job-card-meta">
                  <div className="job-meta-item">
                    <span className="meta-label">Last Run:</span>
                    <span className="meta-value">{formatRelativeTime(job.lastRunAt)}</span>
                  </div>
                  <div className="job-meta-item">
                    <span className="meta-label">Updated:</span>
                    <span className="meta-value">{formatRelativeTime(job.updatedAt)}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="job-card-details">
                    <div className="job-details-content">
                      <div className="details-section">
                        <h4>Configuration</h4>
                        <div className="details-grid">
                          <div className="detail-item">
                            <span className="detail-label">Status</span>
                            <span className="detail-value">{job.status}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Type</span>
                            <span className="detail-value">{job.type}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Trigger</span>
                            <span className="detail-value">
                              {job.schedule?.enabled ? scheduleLabel(job) : dependencies.length > 0 ? "Triggered" : "Manual"}
                            </span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">Exit Code</span>
                            <span className="detail-value">{job.exitCode ?? "-"}</span>
                          </div>
                          {dependencies.length > 0 && (
                            <div className="detail-item detail-item-full">
                              <span className="detail-label">Depends on</span>
                              <span className="detail-value">
                                {dependencies.map((dep) => `${dep.jobId} (${dep.onStatus})`).join(", ")}
                              </span>
                            </div>
                          )}
                          {job.error && (
                            <div className="detail-item detail-item-full">
                              <span className="detail-label">Last Error</span>
                              <span className="detail-value">{job.error}</span>
                            </div>
                          )}
                        </div>
                        <div className="job-info-note">
                          <span>
                            {job.schedule?.enabled
                              ? "Runs automatically on schedule. Use play/stop controls for manual testing."
                              : "Use play to run once and stop to interrupt active execution."}
                          </span>
                        </div>
                        <div className="job-info-note" style={{ marginTop: 10 }}>
                          <span>Latest logs</span>
                        </div>
                        <pre className="jobs-view-inline-logs">{logs || "Click a job action to load logs."}</pre>
                        <button
                          className="btn-job-action"
                          style={{ marginTop: 8, width: "fit-content", paddingInline: 10 }}
                          onClick={() => void loadLogs(job.id)}
                        >
                          Load Logs
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
