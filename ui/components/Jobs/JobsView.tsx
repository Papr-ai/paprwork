import { useMemo, useState, useRef, useEffect } from "react";
import { useJobs } from "../../hooks/useJobs";
import type { JobRecord } from "../../hooks/useJobs";
import { JobsGraph } from "./JobsGraph";
import "./JobsView.css";

type JobFilter = "all" | "running" | "idle" | "scheduled";
type ViewMode = "list" | "graph";

export function JobsView() {
  const { jobs, graph, loading, error, runJob, stopJob, loadLogs, logsByJobId } =
    useJobs();
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [currentFilter, setCurrentFilter] = useState<JobFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [appDropdownOpen, setAppDropdownOpen] = useState(false);
  const [graphSelectedJobId, setGraphSelectedJobId] = useState<string | null>(null);
  const appDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (appDropdownRef.current && !appDropdownRef.current.contains(e.target as Node)) {
        setAppDropdownOpen(false);
      }
    }
    if (appDropdownOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [appDropdownOpen]);

  const runningCount = jobs.filter(
    (j) => j.status === "running" || j.status === "waiting_permission",
  ).length;
  const scheduledCount = jobs.filter((j) => j.schedule?.enabled).length;

  const appFilteredJobIds = useMemo<Set<string> | null>(() => {
    if (!selectedAppId || !graph) return null;
    return new Set(graph.appLinks[selectedAppId]?.jobIds ?? []);
  }, [selectedAppId, graph]);

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
      if (currentFilter === "running" && !isActive(job)) return false;
      if (currentFilter === "idle" && isActive(job)) return false;
      if (currentFilter === "scheduled" && !job.schedule?.enabled) return false;
      if (!searchQuery.trim()) return true;
      const haystack = `${job.name} ${job.type} ${job.command ?? ""}`.toLowerCase();
      return haystack.includes(searchQuery.toLowerCase());
    });
  }, [jobs, currentFilter, searchQuery, appFilteredJobIds]);

  const groupedJobs = useMemo(() => {
    const folderMap = new Map<string, JobRecord[]>();
    const ungrouped: JobRecord[] = [];
    const folderToAppName = new Map<string, string>();
    if (graph) {
      for (const [, appLink] of Object.entries(graph.appLinks)) {
        for (const jobId of appLink.jobIds) {
          const job = jobs.find((j) => j.id === jobId);
          if (job?.folder) folderToAppName.set(job.folder.toLowerCase(), appLink.name);
        }
      }
    }
    for (const job of filteredJobs) {
      if (job.folder) {
        const displayName = folderToAppName.get(job.folder.toLowerCase()) || job.folder;
        const group = folderMap.get(displayName) ?? [];
        group.push(job);
        folderMap.set(displayName, group);
      } else {
        ungrouped.push(job);
      }
    }
    const sortedFolders = [...folderMap.entries()].sort(([a], [b]) => a.localeCompare(b));
    return { folders: sortedFolders, ungrouped };
  }, [filteredJobs, graph, jobs]);

  const appChips = useMemo(() => {
    if (!graph) return [];
    return Object.entries(graph.appLinks).map(([appId, link]) => ({
      appId,
      name: link.name,
      count: link.jobIds.length,
    }));
  }, [graph]);

  const selectedAppName = useMemo(() => {
    if (!selectedAppId) return "All Apps";
    return appChips.find((c) => c.appId === selectedAppId)?.name ?? "All Apps";
  }, [selectedAppId, appChips]);

  const toggleDetails = (jobId: string) => {
    if (expandedJobId === jobId) {
      setExpandedJobId(null);
    } else {
      setExpandedJobId(jobId);
      void loadLogs(jobId);
    }
  };

  const handleGraphNodeClick = (jobId: string) => {
    setGraphSelectedJobId(jobId);
    setExpandedJobId(jobId);
    setViewMode("list");
  };

  const formatRelativeTime = (isoString?: string): string => {
    if (!isoString) return "Never";
    const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 60) return "Just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return `${Math.floor(seconds / 604800)}w ago`;
  };

  const formatNextRun = (job: JobRecord): string => {
    if (!job.schedule?.enabled) return "";
    const raw = job.scheduleState?.nextRunAt;
    if (!raw) return "Pending";
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return "";
    const diff = d.getTime() - Date.now();
    if (diff <= 0) return "Due now";
    if (diff < 60_000) return `in ${Math.ceil(diff / 1000)}s`;
    if (diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)}m`;
    if (diff < 86_400_000) return `in ${Math.ceil(diff / 3_600_000)}h`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const scheduleLabel = (job: JobRecord): string => {
    const s = job.schedule;
    if (!s) return "";
    if (s.cron) return s.cron;
    if (s.intervalMs) {
      const sec = s.intervalMs / 1000;
      if (sec < 60) return `Every ${sec}s`;
      if (sec < 3600) return `Every ${sec / 60}m`;
      return `Every ${sec / 3600}h`;
    }
    return "Scheduled";
  };

  const renderJobRow = (job: JobRecord) => {
    const isRunning = job.status === "running";
    const isWaiting = job.status === "waiting_permission";
    const isActive = isRunning || isWaiting;
    const isExpanded = expandedJobId === job.id;
    const isGraphSelected = job.id === graphSelectedJobId;

    return (
      <div
        className={`jv2-row ${isExpanded ? "jv2-row--expanded" : ""} ${isGraphSelected ? "jv2-row--highlighted" : ""}`}
        key={job.id}
      >
        <div className="jv2-row-main" onClick={() => toggleDetails(job.id)}>
          <div className="jv2-row-left">
            <span
              className={`jv2-dot ${isWaiting ? "jv2-dot--waiting" : isRunning ? "jv2-dot--running" : job.status === "failed" ? "jv2-dot--failed" : ""}`}
            />
            <span className="jv2-name">{job.name}</span>
            <span className="jv2-type">{job.type}</span>
          </div>
          <div className="jv2-row-right">
            {job.schedule?.enabled && (
              <span className="jv2-sched">{scheduleLabel(job)}</span>
            )}
            {isWaiting && (
              <span className="jv2-badge jv2-badge--waiting">Awaiting approval</span>
            )}
            <span className="jv2-time">{formatRelativeTime(job.lastRunAt)}</span>
            <div className="jv2-actions" onClick={(e) => e.stopPropagation()}>
              {isActive ? (
                <button
                  className="jv2-btn"
                  title="Stop"
                  onClick={() => void stopJob(job.id)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <rect x="6" y="6" width="12" height="12" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </button>
              ) : (
                <button
                  className="jv2-btn"
                  title="Run"
                  onClick={() => void runJob(job.id)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M8 5v14l11-7-11-7z" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>

        {isExpanded && (
          <div className="jv2-detail">
            <div className="jv2-detail-grid">
              <div className="jv2-detail-cell">
                <span className="jv2-detail-label">Status</span>
                <span className={`jv2-detail-value ${isActive ? "jv2-detail-value--active" : ""}`}>
                  {job.status}
                </span>
              </div>
              <div className="jv2-detail-cell">
                <span className="jv2-detail-label">Last Run</span>
                <span className="jv2-detail-value">{formatRelativeTime(job.lastRunAt)}</span>
              </div>
              {job.schedule?.enabled && (
                <div className="jv2-detail-cell">
                  <span className="jv2-detail-label">Next Run</span>
                  <span className="jv2-detail-value">{formatNextRun(job)}</span>
                </div>
              )}
              {job.exitCode !== undefined && job.exitCode !== null && (
                <div className="jv2-detail-cell">
                  <span className="jv2-detail-label">Exit Code</span>
                  <span className="jv2-detail-value">{job.exitCode}</span>
                </div>
              )}
              {job.lastEvaluation && (
                <div className="jv2-detail-cell">
                  <span className="jv2-detail-label">Eval</span>
                  <span className={`jv2-detail-value ${job.lastEvaluation.passed ? "jv2-eval--pass" : "jv2-eval--fail"}`}>
                    {Math.round(job.lastEvaluation.score * 100)}% {job.lastEvaluation.passed ? "Pass" : "Fail"}
                  </span>
                </div>
              )}
              {job.error && (
                <div className="jv2-detail-cell jv2-detail-cell--full">
                  <span className="jv2-detail-label">Error</span>
                  <span className="jv2-detail-value jv2-detail-value--error">{job.error}</span>
                </div>
              )}
            </div>
            {job.command && (
              <pre className="jv2-command">
                {job.command.length > 200 ? job.command.slice(0, 200) + "…" : job.command}
              </pre>
            )}
            <div className="jv2-logs-section">
              <div className="jv2-logs-header">
                <span className="jv2-detail-label">Logs</span>
                <button className="jv2-btn-text" onClick={() => void loadLogs(job.id)}>
                  Refresh
                </button>
              </div>
              <pre className="jv2-logs">
                {logsByJobId[job.id] || "No logs loaded yet."}
              </pre>
            </div>
          </div>
        )}
      </div>
    );
  };

  const hasFolders = groupedJobs.folders.length > 0;

  return (
    <div className="jv2">
      {/* ── Header: title + search ── */}
      <div className="jv2-header">
        <div className="jv2-header-left">
          <h1 className="jv2-title">Jobs</h1>
          <div className="jv2-header-stats">
            {runningCount > 0 && (
              <span className="jv2-stat jv2-stat--running">{runningCount} running</span>
            )}
            <span className="jv2-stat">{jobs.length} total</span>
            {scheduledCount > 0 && (
              <span className="jv2-stat">{scheduledCount} scheduled</span>
            )}
          </div>
        </div>
        <div className="jv2-header-right">
          <div className="jv2-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="jv2-search-icon">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.5" />
              <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search jobs…"
            />
          </div>
          <div className="jv2-view-toggle">
            <button
              className={viewMode === "list" ? "jv2-toggle jv2-toggle--active" : "jv2-toggle"}
              onClick={() => setViewMode("list")}
            >
              List
            </button>
            <button
              className={viewMode === "graph" ? "jv2-toggle jv2-toggle--active" : "jv2-toggle"}
              onClick={() => setViewMode("graph")}
            >
              Graph
            </button>
          </div>
        </div>
      </div>

      {/* ── Toolbar: app dropdown + status filters ── */}
      <div className="jv2-toolbar">
        {appChips.length > 0 && (
          <div className="jv2-app-dropdown" ref={appDropdownRef}>
            <button
              className={`jv2-app-trigger ${selectedAppId ? "jv2-app-trigger--active" : ""}`}
              onClick={() => setAppDropdownOpen(!appDropdownOpen)}
            >
              {selectedAppName}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                <polyline points="6 9 12 15 18 9" stroke="currentColor" strokeWidth="2" />
              </svg>
            </button>
            {appDropdownOpen && (
              <div className="jv2-app-menu">
                <button
                  className={`jv2-app-option ${!selectedAppId ? "jv2-app-option--active" : ""}`}
                  onClick={() => { setSelectedAppId(null); setAppDropdownOpen(false); }}
                >
                  All Apps
                  <span className="jv2-app-count">{jobs.length}</span>
                </button>
                {appChips.map(({ appId, name, count }) => (
                  <button
                    key={appId}
                    className={`jv2-app-option ${selectedAppId === appId ? "jv2-app-option--active" : ""}`}
                    onClick={() => { setSelectedAppId(appId); setAppDropdownOpen(false); }}
                  >
                    {name}
                    <span className="jv2-app-count">{count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="jv2-filters">
          {(["all", "running", "scheduled", "idle"] as JobFilter[]).map((f) => (
            <button
              key={f}
              className={currentFilter === f ? "jv2-filter jv2-filter--active" : "jv2-filter"}
              onClick={() => setCurrentFilter(f)}
            >
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="jv2-content">
        {viewMode === "graph" && graph ? (
          <JobsGraph
            jobs={filteredJobs}
            graph={graph}
            selectedJobId={graphSelectedJobId}
            onJobClick={handleGraphNodeClick}
          />
        ) : (
          <div className="jv2-list">
            {loading && <p className="jv2-empty">Loading…</p>}
            {error && <p className="jv2-empty">{error}</p>}
            {!loading && filteredJobs.length === 0 && (
              <div className="jv2-empty">
                <p>No matching jobs</p>
              </div>
            )}

            {hasFolders &&
              groupedJobs.folders.map(([folder, folderJobs]) => (
                <div className="jv2-group" key={folder}>
                  <div className="jv2-group-header">
                    <span className="jv2-group-name">{folder}</span>
                    <span className="jv2-group-count">{folderJobs.length}</span>
                  </div>
                  {folderJobs.map((job) => renderJobRow(job))}
                </div>
              ))}

            {groupedJobs.ungrouped.length > 0 && hasFolders && (
              <div className="jv2-group">
                <div className="jv2-group-header jv2-group-header--muted">
                  <span className="jv2-group-name">Ungrouped</span>
                  <span className="jv2-group-count">{groupedJobs.ungrouped.length}</span>
                </div>
                {groupedJobs.ungrouped.map((job) => renderJobRow(job))}
              </div>
            )}

            {groupedJobs.ungrouped.length > 0 &&
              !hasFolders &&
              groupedJobs.ungrouped.map((job) => renderJobRow(job))}
          </div>
        )}
      </div>
    </div>
  );
}
