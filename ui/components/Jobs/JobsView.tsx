import { useMemo, useState, useRef, useEffect } from "react";
import { useJobs } from "../../hooks/useJobs";
import type { JobRecord } from "../../hooks/useJobs";
import { useArtifactsStore } from "../../stores/artifactsStore";
import { useArtifacts } from "../../hooks/useArtifacts";
import { AppWorkflow } from "./AppWorkflow";
import { renderAppIcon } from "../../utils/renderAppIcon";
import "./JobsView.css";

type JobFilter = "all" | "running" | "idle" | "scheduled";
type ViewMode = "list" | "workflow";

export function JobsView() {
  const { jobs, graph, loading, error, runJob, stopJob, loadLogs, logsByJobId, defaultModel } =
    useJobs();
  const artifacts = useArtifactsStore((s) => s.artifacts);
  const { loadArtifacts } = useArtifacts();
  const [viewMode, setViewMode] = useState<ViewMode>("workflow");
  const [currentFilter, setCurrentFilter] = useState<JobFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [appDropdownOpen, setAppDropdownOpen] = useState(false);
  const [workflowSelectedJobId, setWorkflowSelectedJobId] = useState<string | null>(null);
  const appDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

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

  const appChips = useMemo(() => {
    if (!graph) return [];
    return Object.entries(graph.appLinks).map(([appId, link]) => ({
      appId,
      name: link.name,
      count: link.jobIds.length,
    }));
  }, [graph]);

  // Auto-select first app in workflow view (default landing experience)
  useEffect(() => {
    if (viewMode === "workflow" && !selectedAppId && appChips.length > 0) {
      setSelectedAppId(appChips[0].appId);
    }
  }, [viewMode, selectedAppId, appChips]);

  const selectedApp = useMemo(() => {
    if (!selectedAppId) return null;
    const chip = appChips.find((c) => c.appId === selectedAppId);
    const artifact = artifacts.find((a) => a.id === selectedAppId && a.type === "app");
    return {
      appId: selectedAppId,
      name: chip?.name ?? artifact?.title ?? "App",
      icon: artifact?.icon,
      jobCount: chip?.count ?? 0,
    };
  }, [selectedAppId, appChips, artifacts]);

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
    const appMap = new Map<string, JobRecord[]>();
    const ungrouped: JobRecord[] = [];

    for (const job of filteredJobs) {
      let grouped = false;
      if (graph) {
        for (const [, appLink] of Object.entries(graph.appLinks)) {
          if (appLink.jobIds.includes(job.id)) {
            const group = appMap.get(appLink.name) ?? [];
            group.push(job);
            appMap.set(appLink.name, group);
            grouped = true;
            break;
          }
        }
      }
      if (!grouped) {
        ungrouped.push(job);
      }
    }

    const sortedApps = [...appMap.entries()].sort(([a], [b]) => a.localeCompare(b));
    return { apps: sortedApps, ungrouped };
  }, [filteredJobs, graph]);

  const selectedAppName = useMemo(() => {
    if (!selectedAppId) return "All Apps";
    return appChips.find((c) => c.appId === selectedAppId)?.name ?? "All Apps";
  }, [selectedAppId, appChips]);

  const workflowSelectedJob = useMemo(
    () => jobs.find((j) => j.id === workflowSelectedJobId) ?? null,
    [jobs, workflowSelectedJobId],
  );

  const toggleDetails = (jobId: string) => {
    if (expandedJobId === jobId) {
      setExpandedJobId(null);
    } else {
      setExpandedJobId(jobId);
      void loadLogs(jobId);
    }
  };

  const handleWorkflowJobSelect = (jobId: string) => {
    setWorkflowSelectedJobId(jobId);
    void loadLogs(jobId);
  };

  const formatRelativeTime = (isoString?: string): string => {
    if (!isoString) return "";
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return "";
    const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
    if (seconds < 0) return "";
    if (seconds < 60) return "Just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return `${Math.floor(seconds / 604800)}w ago`;
  };

  const lastRunLabel = (job: JobRecord): string => {
    const ran = formatRelativeTime(job.lastRunAt);
    if (ran) return ran;
    const updated = formatRelativeTime(job.updatedAt);
    if (updated) return `Updated ${updated}`;
    return "Never run";
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

  const humanCron = (cron: string): string => {
    const parts = cron.trim().split(/\s+/);
    if (parts.length < 5) return cron;
    const [min, hour, dom, mon, dow] = parts;

    const fmtTime = (h: string, m: string): string => {
      const hr = parseInt(h, 10);
      const mn = parseInt(m, 10);
      if (Number.isNaN(hr)) return "";
      const ampm = hr >= 12 ? "PM" : "AM";
      const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
      return mn === 0 ? `${h12} ${ampm}` : `${h12}:${String(mn).padStart(2, "0")} ${ampm}`;
    };

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const monNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const time = fmtTime(hour, min);

    if (dom === "*" && mon === "*" && dow === "*") {
      if (hour === "*" && min === "*") return "Every minute";
      if (hour === "*") return `Every hour at :${min.padStart(2, "0")}`;
      return `Daily at ${time}`;
    }
    if (dom === "*" && mon === "*" && dow !== "*") {
      const days = dow.split(",").map((d) => dayNames[parseInt(d, 10)] ?? d).join(", ");
      return `${days} at ${time}`;
    }
    if (dow === "*" && mon === "*" && dom !== "*") {
      return `${dom}${dom === "1" ? "st" : dom === "2" ? "nd" : dom === "3" ? "rd" : "th"} of month at ${time}`;
    }
    if (dom !== "*" && mon !== "*") {
      const m = monNames[parseInt(mon, 10)] ?? mon;
      return `${m} ${dom} at ${time}`;
    }
    return cron;
  };

  const triggerLabel = (job: JobRecord): string => {
    const s = job.schedule;
    const deps = job.dependsOn ?? [];

    if (s?.enabled) {
      if (s.cron) return humanCron(s.cron);
      if (s.intervalMs) {
        const sec = s.intervalMs / 1000;
        if (sec < 60) return `Every ${sec}s`;
        if (sec < 3600) return `Every ${Math.round(sec / 60)}m`;
        if (sec < 86400) return `Every ${Math.round(sec / 3600)}h`;
        return `Every ${Math.round(sec / 86400)}d`;
      }
      if (s.atTime) return `At ${s.atTime}`;
      return "Scheduled";
    }
    if (deps.length > 0) {
      const depNames = deps.map((d) => {
        const depJob = jobs.find((j) => j.id === d.jobId);
        return depJob ? depJob.name : d.jobId.slice(0, 8);
      });
      return `After ${depNames.join(", ")}`;
    }
    return "";
  };

  const renderJobRow = (job: JobRecord) => {
    const isRunning = job.status === "running";
    const isWaiting = job.status === "waiting_permission";
    const isActive = isRunning || isWaiting;
    const isExpanded = expandedJobId === job.id;

    const linkedApps: string[] = [];
    if (graph) {
      for (const [, appLink] of Object.entries(graph.appLinks)) {
        if (appLink.jobIds.includes(job.id)) {
          linkedApps.push(appLink.name);
        }
      }
    }

    return (
      <div
        className={`jv2-row ${isExpanded ? "jv2-row--expanded" : ""}`}
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
            {triggerLabel(job) && (
              <span className={`jv2-trigger ${job.dependsOn?.length ? "jv2-trigger--dep" : ""}`}>
                {triggerLabel(job)}
              </span>
            )}
            {isWaiting && (
              <span className="jv2-badge jv2-badge--waiting">Awaiting approval</span>
            )}
            <span className="jv2-time">{lastRunLabel(job)}</span>
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
              {(job.type === "agent" || job.type === "subagent") && (
                <div className="jv2-detail-cell">
                  <span className="jv2-detail-label">Model</span>
                  <span className="jv2-detail-value">
                    {job.model
                      ? `${job.provider ? `${job.provider}/` : ""}${job.model}`
                      : `Default (${defaultModel})`}
                  </span>
                </div>
              )}
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
              {linkedApps.length > 0 && (
                <div className="jv2-detail-cell jv2-detail-cell--full">
                  <span className="jv2-detail-label">Used By Apps</span>
                  <span className="jv2-detail-value">{linkedApps.join(", ")}</span>
                </div>
              )}
            </div>
            {job.command && (
              <div className="jv2-command-section">
                <span className="jv2-detail-label">Command</span>
                <pre className="jv2-command">
                  {job.command.length > 300 ? job.command.slice(0, 300) + "…" : job.command}
                </pre>
              </div>
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

  const renderWorkflowDetailPanel = () => {
    if (!workflowSelectedJob) return null;

    const job = workflowSelectedJob;
    const isRunning = job.status === "running";
    const isWaiting = job.status === "waiting_permission";
    const isActive = isRunning || isWaiting;

    return (
      <div className="jv2-wf-panel">
        <div className="jv2-wf-panel-header">
          <h3 className="jv2-wf-panel-title">{job.name}</h3>
          <span className="jv2-type">{job.type}</span>
          <button
            className="jv2-wf-panel-close"
            title="Close"
            onClick={() => setWorkflowSelectedJobId(null)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="jv2-wf-panel-actions">
          {isActive ? (
            <button className="jv2-wf-action-btn" onClick={() => void stopJob(job.id)}>
              Stop
            </button>
          ) : (
            <button className="jv2-wf-action-btn jv2-wf-action-btn--primary" onClick={() => void runJob(job.id)}>
              Run
            </button>
          )}
        </div>

        <div className="jv2-detail-grid">
          <div className="jv2-detail-cell">
            <span className="jv2-detail-label">Status</span>
            <span className={`jv2-detail-value ${isActive ? "jv2-detail-value--active" : ""}`}>
              {job.status}
            </span>
          </div>
          {triggerLabel(job) && (
            <div className="jv2-detail-cell jv2-detail-cell--full">
              <span className="jv2-detail-label">Trigger</span>
              <span className="jv2-detail-value">{triggerLabel(job)}</span>
            </div>
          )}
          <div className="jv2-detail-cell">
            <span className="jv2-detail-label">Last Run</span>
            <span className="jv2-detail-value">{formatRelativeTime(job.lastRunAt) || "Never"}</span>
          </div>
          {job.schedule?.enabled && (
            <div className="jv2-detail-cell">
              <span className="jv2-detail-label">Next Run</span>
              <span className="jv2-detail-value">{formatNextRun(job)}</span>
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
          <div className="jv2-command-section">
            <span className="jv2-detail-label">Command</span>
            <pre className="jv2-command">
              {job.command.length > 200 ? job.command.slice(0, 200) + "…" : job.command}
            </pre>
          </div>
        )}

        <div className="jv2-logs-section">
          <div className="jv2-logs-header">
            <span className="jv2-detail-label">Logs</span>
            <button className="jv2-btn-text" onClick={() => void loadLogs(job.id)}>
              Refresh
            </button>
          </div>
          <pre className="jv2-logs jv2-logs--panel">
            {logsByJobId[job.id] || "No logs loaded yet."}
          </pre>
        </div>
      </div>
    );
  };

  const hasFolders = groupedJobs.apps.length > 0;
  const isWorkflow = viewMode === "workflow";

  return (
    <div className={`jv2 ${isWorkflow ? "jv2--workflow" : ""}`}>
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
          {!isWorkflow && (
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
          )}
          <div className="jv2-view-toggle">
            <button
              className={viewMode === "list" ? "jv2-toggle jv2-toggle--active" : "jv2-toggle"}
              onClick={() => setViewMode("list")}
            >
              List
            </button>
            <button
              className={viewMode === "workflow" ? "jv2-toggle jv2-toggle--active" : "jv2-toggle"}
              onClick={() => setViewMode("workflow")}
            >
              Workflow
            </button>
          </div>
        </div>
      </div>

      {isWorkflow ? (
        <div className={`jv2-workflow-layout ${workflowSelectedJob ? "jv2-workflow-layout--panel-open" : ""}`}>
          <aside className="jv2-app-sidebar">
            <div className="jv2-app-sidebar-header">
              <span className="jv2-app-sidebar-title">Apps</span>
              <span className="jv2-app-sidebar-count">{appChips.length}</span>
            </div>
            <div className="jv2-app-sidebar-list">
              {appChips.length === 0 && (
                <p className="jv2-app-sidebar-empty">No apps with linked jobs</p>
              )}
              {appChips.map(({ appId, name, count }) => {
                const artifact = artifacts.find((a) => a.id === appId && a.type === "app");
                const isActive = selectedAppId === appId;
                return (
                  <button
                    key={appId}
                    className={`jv2-app-sidebar-item ${isActive ? "jv2-app-sidebar-item--active" : ""}`}
                    onClick={() => {
                      setSelectedAppId(appId);
                      setWorkflowSelectedJobId(null);
                    }}
                  >
                    <span className="jv2-app-sidebar-icon">
                      {renderAppIcon(artifact?.icon, { size: 14 })}
                    </span>
                    <span className="jv2-app-sidebar-name">{name}</span>
                    <span className="jv2-app-count">{count}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="jv2-workflow-main">
            {selectedApp && graph ? (
              <AppWorkflow
                appId={selectedApp.appId}
                appName={selectedApp.name}
                appIcon={selectedApp.icon}
                jobs={jobs}
                graph={graph}
                selectedJobId={workflowSelectedJobId}
                onJobSelect={handleWorkflowJobSelect}
                onCanvasClick={() => setWorkflowSelectedJobId(null)}
                onRunJob={(id) => void runJob(id)}
                onStopJob={(id) => void stopJob(id)}
                triggerLabel={triggerLabel}
              />
            ) : (
              <div className="wf-empty">
                <p className="wf-empty-title">Select an app</p>
                <p className="wf-empty-desc">
                  Choose an app from the sidebar to see its job pipeline.
                </p>
              </div>
            )}
          </div>

          {workflowSelectedJob && (
            <aside className="jv2-wf-detail-sidebar">
              {renderWorkflowDetailPanel()}
            </aside>
          )}
        </div>
      ) : (
        <>
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

          <div className="jv2-content">
            <div className="jv2-list">
              {loading && <p className="jv2-empty">Loading…</p>}
              {error && <p className="jv2-empty">{error}</p>}
              {!loading && filteredJobs.length === 0 && (
                <div className="jv2-empty">
                  <p>No matching jobs</p>
                </div>
              )}

              {hasFolders &&
                groupedJobs.apps.map(([appName, appJobs]) => (
                  <div className="jv2-group" key={appName}>
                    <div className="jv2-group-header">
                      <span className="jv2-group-name">{appName}</span>
                      <span className="jv2-group-count">{appJobs.length}</span>
                    </div>
                    {appJobs.map((job) => renderJobRow(job))}
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
          </div>
        </>
      )}
    </div>
  );
}
