import { useMemo, useState } from "react";
import { useJobs } from "../../hooks/useJobs";
import type { JobRecord } from "../../hooks/useJobs";
import { JobsGraph } from "./JobsGraph";
import "./JobsView.css";

type JobFilter = "all" | "running" | "idle" | "scheduled" | "disabled";
type ViewMode = "list" | "graph";

export function JobsView() {
  const { jobs, graph, loading, error, runJob, stopJob, loadLogs, logsByJobId } =
    useJobs();
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [currentFilter, setCurrentFilter] = useState<JobFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set());
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [graphSelectedJobId, setGraphSelectedJobId] = useState<string | null>(
    null,
  );

  const runningCount = jobs.filter(
    (job) => job.status === "running" || job.status === "waiting_permission",
  ).length;
  const idleCount = jobs.filter(
    (job) => job.status !== "running" && job.status !== "waiting_permission",
  ).length;
  const scheduledCount = jobs.filter((job) => job.schedule?.enabled).length;

  // Jobs visible for selected app (from graph appLinks)
  const appFilteredJobIds = useMemo<Set<string> | null>(() => {
    if (!selectedAppId || !graph) return null;
    return new Set(graph.appLinks[selectedAppId]?.jobIds ?? []);
  }, [selectedAppId, graph]);

  // Status + type + app + search filtered jobs
  const filteredJobs = useMemo(() => {
    const isActive = (j: JobRecord) =>
      j.status === "running" || j.status === "waiting_permission";
    const sorted = [...jobs].sort((a, b) => {
      if (isActive(a) && !isActive(b)) return -1;
      if (!isActive(a) && isActive(b)) return 1;
      return a.name.localeCompare(b.name);
    });

    return sorted.filter((job) => {
      if (appFilteredJobIds && !appFilteredJobIds.has(job.id)) return false;
      const isActive =
        job.status === "running" || job.status === "waiting_permission";
      if (currentFilter === "running" && !isActive) return false;
      if (currentFilter === "idle" && isActive) return false;
      if (currentFilter === "scheduled" && !job.schedule?.enabled) return false;
      if (currentFilter === "disabled") return false;
      if (!searchQuery.trim()) return true;
      const haystack =
        `${job.name} ${job.type} ${job.command ?? ""}`.toLowerCase();
      return haystack.includes(searchQuery.toLowerCase());
    });
  }, [jobs, currentFilter, searchQuery, appFilteredJobIds]);

  // Group filtered jobs by folder OR matching app
  const groupedJobs = useMemo(() => {
    const folderMap = new Map<string, JobRecord[]>();
    const ungrouped: JobRecord[] = [];

    // Build a map of folder names to app names for display
    const folderToAppName = new Map<string, string>();
    if (graph) {
      for (const [appId, appLink] of Object.entries(graph.appLinks)) {
        // For each app, check if any jobs have folders that match the app title
        for (const jobId of appLink.jobIds) {
          const job = jobs.find(j => j.id === jobId);
          if (job?.folder) {
            // Map this folder name to the app name (for consistent display)
            folderToAppName.set(job.folder.toLowerCase(), appLink.name);
          }
        }
      }
    }

    for (const job of filteredJobs) {
      if (job.folder) {
        // Use app name if folder matches an app, otherwise use raw folder name
        const displayName = folderToAppName.get(job.folder.toLowerCase()) || job.folder;
        const group = folderMap.get(displayName) ?? [];
        group.push(job);
        folderMap.set(displayName, group);
      } else {
        ungrouped.push(job);
      }
    }

    // Sort folders alphabetically
    const sortedFolders = [...folderMap.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return { folders: sortedFolders, ungrouped };
  }, [filteredJobs, graph, jobs]);

  // App chips from graph
  const appChips = useMemo(() => {
    if (!graph) return [];
    return Object.entries(graph.appLinks).map(([appId, link]) => ({
      appId,
      name: link.name,
    }));
  }, [graph]);

  const toggleDetails = (jobId: string) => {
    setExpandedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const handleGraphNodeClick = (jobId: string) => {
    setGraphSelectedJobId(jobId);
    setExpandedJobIds((prev) => {
      const next = new Set(prev);
      next.add(jobId);
      return next;
    });
    setViewMode("list");
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

  const formatAbsoluteShort = (isoString?: string): string => {
    if (!isoString) return "—";
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  };

  const formatNextRunSummary = (job: JobRecord): string => {
    if (!job.schedule?.enabled) return "—";
    const raw = job.scheduleState?.nextRunAt;
    if (!raw) return "Not set (will reconcile on load)";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return "—";
    const nowMs = Date.now();
    const isPast = d.getTime() <= nowMs;
    
    if (job.status === "running" || job.status === "waiting_permission") {
      if (isPast) {
        return "Running current slot...";
      }
    }
    
    if (isPast) {
      return `Due now · ${formatAbsoluteShort(raw)}`;
    }
    const diff = d.getTime() - nowMs;
    if (diff < 60_000) {
      return `in ${Math.max(1, Math.ceil(diff / 1000))}s · ${formatAbsoluteShort(raw)}`;
    }
    if (diff < 3_600_000) {
      return `in ${Math.ceil(diff / 60_000)}m · ${formatAbsoluteShort(raw)}`;
    }
    if (diff < 86_400_000) {
      return `in ${Math.ceil(diff / 3_600_000)}h · ${formatAbsoluteShort(raw)}`;
    }
    return formatAbsoluteShort(raw);
  };

  const scheduleLabel = (job: {
    schedule?: { cron?: string; intervalMs?: number; atTime?: string };
  }): string => {
    const schedule = job.schedule;
    if (!schedule) return "Manual";
    if (schedule.cron) return "Scheduled";
    if (schedule.intervalMs) return `Every ${schedule.intervalMs}ms`;
    if (schedule.atTime) return `At ${schedule.atTime}`;
    return "Scheduled";
  };

  const renderJobCard = (job: JobRecord) => {
    const isRunning = job.status === "running";
    const isWaitingPermission = job.status === "waiting_permission";
    const isActive = isRunning || isWaitingPermission;
    const isExpanded = expandedJobIds.has(job.id);
    const dependencies = job.dependsOn ?? [];
    const isGraphSelected = job.id === graphSelectedJobId;

    return (
      <div
        className={
          isGraphSelected ? "job-card job-card--highlighted" : "job-card"
        }
        key={job.id}
      >
        <div className="job-card-header" onClick={() => toggleDetails(job.id)}>
          <div className="job-card-main">
            <div className="job-title-row">
              <div
                className={
                  isWaitingPermission
                    ? "job-status-indicator status-waiting-permission"
                    : isRunning
                      ? "job-status-indicator status-running"
                      : "job-status-indicator status-idle"
                }
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <circle cx="5" cy="5" r="3" fill="currentColor" />
                </svg>
              </div>
              <h3 className="job-title">{job.name}</h3>
              <span className="job-type-badge">{job.type}</span>
              {job.lastEvaluation && (
                <span
                  className={`job-eval-badge ${job.lastEvaluation.passed ? "job-eval-pass" : "job-eval-fail"}`}
                  title={`Last eval: ${Math.round(job.lastEvaluation.score * 100)}% — ${job.lastEvaluation.passed ? "Passed" : "Failed"}`}
                >
                  {job.lastEvaluation.passed ? "✓" : "✗"} {Math.round(job.lastEvaluation.score * 100)}%
                </span>
              )}
              {job.recipe?.enabled && !job.lastEvaluation && (
                <span className="job-eval-badge job-eval-pending" title="Recipe enabled, no evaluations yet">
                  ◉ Recipe
                </span>
              )}
              {job.schedule?.enabled && (
                <span className="job-schedule-badge">{scheduleLabel(job)}</span>
              )}
              {dependencies.length > 0 && (
                <span className="job-trigger-badge">Triggered</span>
              )}
            </div>
            {job.command && (
              <p className="job-description">
                {(() => {
                  const firstLine = job.command.split("\n")[0].trim();
                  return firstLine.length > 72
                    ? firstLine.slice(0, 70) + "…"
                    : firstLine;
                })()}
              </p>
            )}
          </div>
          {isWaitingPermission && job.waitingPermissionKeys?.length ? (
            <div className="job-card-waiting-keys">
              Waiting for approval: {job.waitingPermissionKeys.join(", ")}
            </div>
          ) : null}
          <div
            className="job-card-actions"
            onClick={(event) => event.stopPropagation()}
          >
            {isActive ? (
              <button
                className="btn-job-action btn-job-delete"
                title="Stop Job"
                onClick={() => void stopJob(job.id)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <rect
                    x="6"
                    y="6"
                    width="12"
                    height="12"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
              </button>
            ) : null}
            {!isActive ? (
              <button
                className="btn-job-action btn-job-test"
                title="Test Job (Run Once)"
                onClick={() => void runJob(job.id)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M8 5v14l11-7-11-7z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
              </button>
            ) : null}
            <button
              className={
                isExpanded
                  ? "btn-job-action btn-job-expand expanded"
                  : "btn-job-action btn-job-expand"
              }
              onClick={(e) => {
                e.stopPropagation();
                toggleDetails(job.id);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <polyline
                  points="6 9 12 15 18 9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            </button>
          </div>
        </div>

        <div className="job-card-meta">
          <div className="job-meta-item">
            <span className="meta-label">Last Run:</span>
            <span className="meta-value">
              {formatRelativeTime(job.lastRunAt)}
            </span>
          </div>
          <div className="job-meta-item">
            <span className="meta-label">Updated:</span>
            <span className="meta-value">
              {formatRelativeTime(job.updatedAt)}
            </span>
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
                      {job.schedule?.enabled
                        ? scheduleLabel(job)
                        : dependencies.length > 0
                          ? "Triggered"
                          : "Manual"}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Exit Code</span>
                    <span className="detail-value">{job.exitCode ?? "-"}</span>
                  </div>
                  {job.lastEvaluation && (
                    <div className="detail-item">
                      <span className="detail-label">Eval Score</span>
                      <span className={`detail-value ${job.lastEvaluation.passed ? "eval-passed" : "eval-failed"}`}>
                        {Math.round(job.lastEvaluation.score * 100)}% — {job.lastEvaluation.passed ? "Passed" : "Failed"}
                      </span>
                    </div>
                  )}
                  {job.recipe?.enabled && (
                    <div className="detail-item">
                      <span className="detail-label">Recipe</span>
                      <span className="detail-value">
                        Enabled (threshold: {Math.round((job.recipe.passThreshold ?? 0.7) * 100)}%)
                      </span>
                    </div>
                  )}
                  {job.folder && (
                    <div className="detail-item">
                      <span className="detail-label">Folder</span>
                      <span className="detail-value">{job.folder}</span>
                    </div>
                  )}
                  {dependencies.length > 0 && (
                    <div className="detail-item detail-item-full">
                      <span className="detail-label">Depends on</span>
                      <span className="detail-value">
                        {dependencies
                          .map((dep) => `${dep.jobId} (${dep.onStatus})`)
                          .join(", ")}
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
                {job.schedule?.enabled ? (
                  <div className="details-section">
                    <h4>Schedule</h4>
                    <div className="details-grid">
                      <div className="detail-item">
                        <span className="detail-label">Next run</span>
                        <span className="detail-value">
                          {formatNextRunSummary(job)}
                        </span>
                      </div>
                      <div className="detail-item detail-item-full">
                        <span className="detail-label">Rule</span>
                        <span className="detail-value">
                          {job.schedule.cron
                            ? `Cron: ${job.schedule.cron}`
                            : job.schedule.intervalMs
                              ? `Every ${job.schedule.intervalMs} ms`
                              : job.schedule.atTime
                                ? `One shot at ${job.schedule.atTime}`
                                : "Scheduled"}
                          {job.schedule.timezone
                            ? ` · TZ ${job.schedule.timezone}`
                            : ""}
                          {job.schedule.catchUpMissed
                            ? " · catch-up missed runs"
                            : ""}
                        </span>
                      </div>
                      {job.scheduleState?.lastScheduledRunAt ? (
                        <div className="detail-item">
                          <span className="detail-label">Last scheduled slot</span>
                          <span className="detail-value">
                            {formatAbsoluteShort(
                              job.scheduleState.lastScheduledRunAt,
                            )}{" "}
                            ({formatRelativeTime(
                              job.scheduleState.lastScheduledRunAt,
                            )}
                            )
                          </span>
                        </div>
                      ) : null}
                      {job.scheduleState?.lastTriggeredAt ? (
                        <div className="detail-item">
                          <span className="detail-label">Last trigger</span>
                          <span className="detail-value">
                            {formatAbsoluteShort(
                              job.scheduleState.lastTriggeredAt,
                            )}{" "}
                            ({formatRelativeTime(
                              job.scheduleState.lastTriggeredAt,
                            )}
                            )
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <div className="job-info-note">
                  <span>
                    {job.schedule?.enabled
                      ? "Runs automatically while Paprwork is open and the gateway is running. Closing the app pauses schedules. Use play/stop for manual runs."
                      : "Use play to run once and stop to interrupt active execution."}
                  </span>
                </div>
                <div className="job-info-note" style={{ marginTop: 10 }}>
                  <span>Latest logs</span>
                </div>
                <pre className="jobs-view-inline-logs">
                  {logsByJobId[job.id] || "Click 'Load Logs' to view logs for this job."}
                </pre>
                <button
                  className="btn-job-action"
                  style={{
                    marginTop: 8,
                    width: "fit-content",
                    paddingInline: 10,
                  }}
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
  };

  const renderFolderSection = (folder: string, folderJobs: JobRecord[]) => {
    return (
      <div className="jobs-folder-section" key={folder}>
        <div className="jobs-folder-header">
          <span className="jobs-folder-name">{folder}</span>
          <span className="jobs-folder-count">{folderJobs.length}</span>
        </div>
        <div className="jobs-folder-content">
          {folderJobs.map((job) => renderJobCard(job))}
        </div>
      </div>
    );
  };

  const hasAnyJobs = filteredJobs.length > 0;
  const hasFolders = groupedJobs.folders.length > 0;

  return (
    <div className="jobs-page-native">
      {/* Header */}
      <div className="jobs-header-native">
        <div className="jobs-header-left">
          <h1>Background Jobs</h1>
          <p className="jobs-subtitle">
            Manage scheduled tasks and background processes
          </p>
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
          {/* View toggle */}
          <div className="jobs-view-toggle">
            <button
              className={
                viewMode === "list"
                  ? "view-toggle-btn view-toggle-btn--active"
                  : "view-toggle-btn"
              }
              onClick={() => setViewMode("list")}
              title="List view"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <line
                  x1="3"
                  y1="6"
                  x2="21"
                  y2="6"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <line
                  x1="3"
                  y1="12"
                  x2="21"
                  y2="12"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <line
                  x1="3"
                  y1="18"
                  x2="21"
                  y2="18"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
              List
            </button>
            <button
              className={
                viewMode === "graph"
                  ? "view-toggle-btn view-toggle-btn--active"
                  : "view-toggle-btn"
              }
              onClick={() => setViewMode("graph")}
              title="Graph view"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle
                  cx="5"
                  cy="12"
                  r="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <circle
                  cx="19"
                  cy="6"
                  r="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <circle
                  cx="19"
                  cy="18"
                  r="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <line
                  x1="7"
                  y1="11"
                  x2="17"
                  y2="7"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <line
                  x1="7"
                  y1="13"
                  x2="17"
                  y2="17"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
              Graph
            </button>
          </div>
        </div>
      </div>

      {/* App filter chips */}
      {appChips.length > 0 && (
        <div className="jobs-app-filter">
          <button
            className={
              selectedAppId === null ? "app-chip app-chip--active" : "app-chip"
            }
            onClick={() => setSelectedAppId(null)}
          >
            All Apps
          </button>
          {appChips.map(({ appId, name }) => (
            <button
              key={appId}
              className={
                selectedAppId === appId
                  ? "app-chip app-chip--active"
                  : "app-chip"
              }
              onClick={() =>
                setSelectedAppId(selectedAppId === appId ? null : appId)
              }
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Status filters + search */}
      <div className="jobs-filters">
        <div className="filter-tabs">
          {(
            ["all", "running", "idle", "scheduled", "disabled"] as JobFilter[]
          ).map((filter) => (
            <button
              key={filter}
              className={
                currentFilter === filter ? "filter-tab active" : "filter-tab"
              }
              onClick={() => setCurrentFilter(filter)}
            >
              {filter === "all"
                ? "All Jobs"
                : filter.charAt(0).toUpperCase() + filter.slice(1)}
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

      {/* Content */}
      <div className="jobs-content-native">
        {viewMode === "graph" && graph ? (
          <JobsGraph
            jobs={filteredJobs}
            graph={graph}
            selectedJobId={graphSelectedJobId}
            onJobClick={handleGraphNodeClick}
          />
        ) : (
          <div className="jobs-list-native">
            {loading && <p className="jobs-loading">Loading jobs...</p>}
            {error && <p className="jobs-loading">{error}</p>}

            {!loading && !hasAnyJobs && (
              <div className="jobs-empty-state">
                <h3>No Matching Jobs</h3>
                <p>Try adjusting your filters or search</p>
              </div>
            )}

            {/* Folder sections */}
            {hasFolders &&
              groupedJobs.folders.map(([folder, folderJobs]) =>
                renderFolderSection(folder, folderJobs),
              )}

            {/* Ungrouped jobs */}
            {groupedJobs.ungrouped.length > 0 && hasFolders && (
              <div className="jobs-folder-section">
                <div className="jobs-folder-header jobs-folder-header--muted">
                  <span className="jobs-folder-name">Ungrouped</span>
                  <span className="jobs-folder-count">
                    {groupedJobs.ungrouped.length}
                  </span>
                </div>
                <div className="jobs-folder-content">
                  {groupedJobs.ungrouped.map((job) => renderJobCard(job))}
                </div>
              </div>
            )}
            {groupedJobs.ungrouped.length > 0 &&
              !hasFolders &&
              groupedJobs.ungrouped.map((job) => renderJobCard(job))}
          </div>
        )}
      </div>
    </div>
  );
}
