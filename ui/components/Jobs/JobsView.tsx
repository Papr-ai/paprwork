import { useCallback, useMemo, useState, useRef, useEffect } from "react";
import { useJobs } from "../../hooks/useJobs";
import type { JobRecord } from "../../hooks/useJobs";
import { useChat } from "../../hooks/useChat";
import { useArtifactsStore } from "../../stores/artifactsStore";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useJobNavigationStore } from "../../stores/jobNavigationStore";
import { useTabStore } from "../../stores/tabStore";
import {
  STANDALONE_WORKFLOW_ID,
  getUnlinkedJobIds,
  resolveListAppFilterId,
  resolveWorkflowTarget,
} from "../../utils/jobGraph";
import { openJobDiagnosisChat } from "../../utils/jobDiagnosis";
import { JobPermissionBanner } from "../Chat/JobPermissionBanner";
import { AppWorkflow } from "./AppWorkflow";
import { CloudOnlyJobsBanner, JobCloudSection } from "./JobCloudSection";
import type { JobExecutionPlacement } from "./jobCloudTypes";
import { renderAppIcon } from "../../utils/renderAppIcon";
import {
  buildDelegationRunGroups,
  delegationRunLabel,
  formatDelegationGroupSummary,
  isDelegationRun,
} from "../../utils/delegationJobGrouping";
import {
  JOB_TYPE_FILTER_OPTIONS,
  matchesJobTypeFilter,
  type JobTypeFilter,
} from "../../utils/jobListFilters";
import "./JobsView.css";

type JobFilter = "all" | "running" | "idle" | "scheduled";
type ViewMode = "list" | "workflow";

function CloudRunIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 18h11a4 4 0 000-8 5 5 0 00-9.8-1.2A3.5 3.5 0 007 18z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function JobsView() {
  const {
    jobs,
    graph,
    graphLoaded,
    loading,
    error,
    runJob,
    stopJob,
    deleteJob,
    loadLogs,
    logsByJobId,
    defaultModel,
    cloudStatus,
    loadCloudStatus,
    updateJobPlacement,
    updatingPlacementJobId,
  } = useJobs();
  const [deleteConfirm, setDeleteConfirm] = useState<{
    jobId: string;
    jobName: string;
    deleteFiles: boolean;
    deleteTursoDb: boolean;
  } | null>(null);
  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabStore();
  const artifacts = useArtifactsStore((s) => s.artifacts);
  const { loadArtifacts } = useArtifacts();
  const [viewMode, setViewMode] = useState<ViewMode>("workflow");
  const [currentFilter, setCurrentFilter] = useState<JobFilter>("all");
  const [typeFilter, setTypeFilter] = useState<JobTypeFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [appDropdownOpen, setAppDropdownOpen] = useState(false);
  const [workflowSelectedJobId, setWorkflowSelectedJobId] = useState<string | null>(null);
  const [expandedDelegationGroups, setExpandedDelegationGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [hideCompletedDelegations, setHideCompletedDelegations] = useState(true);
  const appDropdownRef = useRef<HTMLDivElement>(null);
  const focusJobId = useJobNavigationStore((s) => s.focusJobId);
  const clearFocusJob = useJobNavigationStore((s) => s.clearFocusJob);
  const setSelectedJob = useJobNavigationStore((s) => s.setSelectedJob);
  const clearSelectedJob = useJobNavigationStore((s) => s.clearSelectedJob);

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  useEffect(() => {
    if (!focusJobId || loading || !graphLoaded) return;

    const job = jobs.find((entry) => entry.id === focusJobId);
    if (!job) {
      // Keep focusJobId until jobs finish loading (avoid clearing on empty initial state)
      return;
    }

    setCurrentFilter("all");
    setSearchQuery("");

    const { appId } = resolveWorkflowTarget(graph, focusJobId);
    setViewMode("workflow");
    setSelectedAppId(appId);
    setWorkflowSelectedJobId(focusJobId);
    setExpandedJobId(null);

    void loadLogs(focusJobId);
    clearFocusJob();
  }, [focusJobId, jobs, loading, graph, graphLoaded, loadLogs, clearFocusJob]);

  useEffect(() => {
    if (viewMode === "workflow" && workflowSelectedJobId) {
      const job = jobs.find((entry) => entry.id === workflowSelectedJobId);
      if (job) {
        setSelectedJob(job.id, job.name);
      }
      return;
    }

    if (viewMode === "list" && expandedJobId) {
      const job = jobs.find((entry) => entry.id === expandedJobId);
      if (job) {
        setSelectedJob(job.id, job.name);
      }
      return;
    }

    clearSelectedJob();
  }, [
    viewMode,
    workflowSelectedJobId,
    expandedJobId,
    jobs,
    setSelectedJob,
    clearSelectedJob,
  ]);

  const handleDiagnose = useCallback(
    (job: JobRecord) => {
      void openJobDiagnosisChat(job, logsByJobId[job.id] ?? "", {
        createChat,
        createTab,
        switchToTab,
      });
    },
    [createChat, createTab, switchToTab, logsByJobId],
  );

  const handleDeleteJob = useCallback(
    async (jobId: string) => {
      if (!deleteConfirm) return;
      setDeleteConfirm(null);
      await deleteJob(jobId, deleteConfirm.deleteFiles, deleteConfirm.deleteTursoDb);
      if (expandedJobId === jobId) {
        setExpandedJobId(null);
      }
      if (workflowSelectedJobId === jobId) {
        setWorkflowSelectedJobId(null);
      }
    },
    [deleteJob, deleteConfirm, expandedJobId, workflowSelectedJobId],
  );

  const handlePlacementChange = useCallback(
    (jobId: string, placement: JobExecutionPlacement) => {
      void updateJobPlacement(jobId, placement);
    },
    [updateJobPlacement],
  );

  const renderCloudSection = (job: JobRecord) => (
    <JobCloudSection
      job={job}
      cloudStatus={cloudStatus}
      cloudSummary={cloudStatus?.summariesById[job.id]}
      updatingPlacement={updatingPlacementJobId === job.id}
      onPlacementChange={(placement) => handlePlacementChange(job.id, placement)}
      onRefreshCloud={() => void loadCloudStatus()}
    />
  );

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

  const unlinkedJobIds = useMemo(
    () => getUnlinkedJobIds(graph, jobs.map((job) => job.id)),
    [graph, jobs],
  );

  const standaloneSeedJobIds = useMemo(() => {
    if (workflowSelectedJobId) {
      return [workflowSelectedJobId];
    }
    return unlinkedJobIds;
  }, [workflowSelectedJobId, unlinkedJobIds]);

  // Auto-select first app in workflow view (default landing experience)
  useEffect(() => {
    if (viewMode === "workflow" && !selectedAppId && appChips.length > 0) {
      setSelectedAppId(appChips[0].appId);
    }
  }, [viewMode, selectedAppId, appChips]);

  const selectedApp = useMemo(() => {
    if (!selectedAppId) return null;
    if (selectedAppId === STANDALONE_WORKFLOW_ID) {
      return {
        appId: STANDALONE_WORKFLOW_ID,
        name: "Ungrouped",
        icon: undefined,
        jobCount: unlinkedJobIds.length,
      };
    }
    const chip = appChips.find((c) => c.appId === selectedAppId);
    const artifact = artifacts.find((a) => a.id === selectedAppId && a.type === "app");
    return {
      appId: selectedAppId,
      name: chip?.name ?? artifact?.title ?? "App",
      icon: artifact?.icon,
      jobCount: chip?.count ?? 0,
    };
  }, [selectedAppId, appChips, artifacts, unlinkedJobIds.length]);

  const listAppFilterId = useMemo(
    () => resolveListAppFilterId(selectedAppId),
    [selectedAppId],
  );

  const appFilteredJobIds = useMemo<Set<string> | null>(() => {
    if (!listAppFilterId || !graph) return null;
    return new Set(graph.appLinks[listAppFilterId]?.jobIds ?? []);
  }, [listAppFilterId, graph]);

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
      if (!matchesJobTypeFilter(job, typeFilter)) return false;
      if (!searchQuery.trim()) return true;
      const haystack = `${job.name} ${job.type} ${job.command ?? ""}`.toLowerCase();
      return haystack.includes(searchQuery.toLowerCase());
    });
  }, [jobs, currentFilter, typeFilter, searchQuery, appFilteredJobIds]);

  const { regularFilteredJobs, delegationGroups } = useMemo(() => {
    const regular: JobRecord[] = [];
    const delegation: JobRecord[] = [];
    for (const job of filteredJobs) {
      if (isDelegationRun(job)) {
        delegation.push(job);
      } else {
        regular.push(job);
      }
    }
    return {
      regularFilteredJobs: regular,
      delegationGroups: buildDelegationRunGroups(delegation, {
        hideCompleted: hideCompletedDelegations,
      }),
    };
  }, [filteredJobs, hideCompletedDelegations]);

  useEffect(() => {
    setExpandedDelegationGroups((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const group of delegationGroups) {
        if (group.hasActive && !next.has(group.key)) {
          next.add(group.key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [delegationGroups]);

  const groupedJobs = useMemo(() => {
    const appMap = new Map<string, JobRecord[]>();
    const ungrouped: JobRecord[] = [];
    const unlinkedSet = new Set(unlinkedJobIds);

    for (const job of regularFilteredJobs) {
      if (unlinkedSet.has(job.id)) {
        ungrouped.push(job);
        continue;
      }

      if (graph) {
        for (const [, appLink] of Object.entries(graph.appLinks)) {
          if (appLink.jobIds.includes(job.id)) {
            const group = appMap.get(appLink.name) ?? [];
            group.push(job);
            appMap.set(appLink.name, group);
            break;
          }
        }
      }
    }

    const sortedApps = [...appMap.entries()].sort(([a], [b]) => a.localeCompare(b));
    return { apps: sortedApps, ungrouped };
  }, [regularFilteredJobs, graph, unlinkedJobIds]);

  const toggleDelegationGroup = (groupKey: string) => {
    setExpandedDelegationGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  const selectedAppName = useMemo(() => {
    if (!listAppFilterId) return "All Apps";
    return appChips.find((c) => c.appId === listAppFilterId)?.name ?? "All Apps";
  }, [listAppFilterId, appChips]);

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
      void loadCloudStatus();
    }
  };

  const handleWorkflowJobSelect = (jobId: string) => {
    setWorkflowSelectedJobId(jobId);
    void loadLogs(jobId);
    void loadCloudStatus();
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

  const renderJobRow = (
    job: JobRecord,
    options?: { displayName?: string; nested?: boolean },
  ) => {
    const isRunning = job.status === "running";
    const isWaiting = job.status === "waiting_permission";
    const isActive = isRunning || isWaiting;
    const isExpanded = expandedJobId === job.id;
    const rowLabel = options?.displayName ?? job.name;

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
        id={`job-row-${job.id}`}
        className={`jv2-row ${options?.nested ? "jv2-row--nested" : ""} ${isExpanded ? "jv2-row--expanded" : ""}`}
        key={job.id}
      >
        <div className="jv2-row-main" onClick={() => toggleDetails(job.id)}>
          <div className="jv2-row-left">
            <span
              className={`jv2-dot ${isWaiting ? "jv2-dot--waiting" : isRunning ? "jv2-dot--running" : job.status === "failed" ? "jv2-dot--failed" : ""}`}
            />
            <span className="jv2-name">{rowLabel}</span>
            {!options?.nested && <span className="jv2-type">{job.type}</span>}
            {options?.nested && (
              <span className="jv2-type jv2-type--muted">{job.status}</span>
            )}
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
            {job.executionCapability === "local-only" && (
              <span
                className="jv2-row-cloud-badge jv2-row-cloud-badge--local-only"
                title="Future scheduled runs stay on this device — cloud scheduler won't fire this job"
              >
                Schedules locally
              </span>
            )}
            {job.lastRunSource?.startsWith("cloud") && (
              <span
                className="jv2-row-cloud-badge"
                title="Most recent run executed on Papr Cloud (one-off manual run or past schedule setting)"
              >
                Last: cloud
              </span>
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
                <>
                  <button
                    className="jv2-btn"
                    title="Run locally"
                    onClick={() => void runJob(job.id)}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <path d="M8 5v14l11-7-11-7z" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </button>
                  <button
                    className="jv2-btn jv2-btn--cloud"
                    title="Run in cloud"
                    onClick={() => void runJob(job.id, "cloud")}
                  >
                    <CloudRunIcon />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {isExpanded && (
          <div className="jv2-detail">
            <div className="jv2-wf-panel-actions jv2-detail-actions">
              {isActive ? (
                <button
                  className="jv2-wf-action-btn"
                  onClick={() => void stopJob(job.id)}
                >
                  Stop
                </button>
              ) : (
                <>
                  <button
                    className="jv2-wf-action-btn jv2-wf-action-btn--primary"
                    onClick={() => void runJob(job.id)}
                  >
                    Run
                  </button>
                  <button
                    className="jv2-wf-action-btn jv2-wf-action-btn--cloud"
                    title="Push to cloud and run on Papr Cloud"
                    onClick={() => void runJob(job.id, "cloud")}
                  >
                    Run in Cloud
                  </button>
                  <button
                    className="jv2-wf-action-btn"
                    onClick={() => handleDiagnose(job)}
                  >
                    Diagnose
                  </button>
                  <button
                    className="jv2-wf-action-btn jv2-wf-action-btn--danger"
                    onClick={() =>
                      setDeleteConfirm({
                        jobId: job.id,
                        jobName: job.name,
                        deleteFiles: true,
                        deleteTursoDb: true,
                      })
                    }
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
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
            {renderCloudSection(job)}
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
            <>
              <button
                className="jv2-wf-action-btn jv2-wf-action-btn--primary"
                onClick={() => void runJob(job.id)}
              >
                Run
              </button>
              <button
                className="jv2-wf-action-btn jv2-wf-action-btn--cloud"
                title="Push to cloud and run on Papr Cloud"
                onClick={() => void runJob(job.id, "cloud")}
              >
                Run in Cloud
              </button>
              <button
                className="jv2-wf-action-btn"
                onClick={() => handleDiagnose(job)}
              >
                Diagnose
              </button>
              <button
                className="jv2-wf-action-btn jv2-wf-action-btn--danger"
                onClick={() =>
                  setDeleteConfirm({
                    jobId: job.id,
                    jobName: job.name,
                    deleteFiles: true,
                    deleteTursoDb: true,
                  })
                }
              >
                Delete
              </button>
            </>
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

        {renderCloudSection(job)}

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

  const renderDelegationSection = () => {
    if (delegationGroups.length === 0) {
      return null;
    }

    return (
      <div className="jv2-group jv2-group--delegations">
        <div className="jv2-group-header jv2-group-header--delegations">
          <span className="jv2-group-name">Delegations</span>
          <label className="jv2-delegation-filter">
            <input
              type="checkbox"
              checked={hideCompletedDelegations}
              onChange={(event) => setHideCompletedDelegations(event.target.checked)}
            />
            Hide completed
          </label>
        </div>
        {delegationGroups.map((group) => {
          const isExpanded = expandedDelegationGroups.has(group.key);
          return (
            <div
              key={group.key}
              className={`jv2-delegation-group ${isExpanded ? "jv2-delegation-group--expanded" : ""}`}
            >
              <button
                type="button"
                className="jv2-delegation-summary"
                onClick={() => toggleDelegationGroup(group.key)}
              >
                <span className="jv2-delegation-summary-left">
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    className={`jv2-delegation-chevron ${isExpanded ? "jv2-delegation-chevron--open" : ""}`}
                    aria-hidden
                  >
                    <polyline points="9 6 15 12 9 18" stroke="currentColor" strokeWidth="2" />
                  </svg>
                  {group.hasActive && <span className="jv2-dot jv2-dot--running" />}
                  <span className="jv2-delegation-profile">{group.profileName}</span>
                  <span className="jv2-delegation-meta">
                    {formatDelegationGroupSummary(group)}
                  </span>
                </span>
                <span className="jv2-delegation-last">
                  {group.lastRunAt ? `Last ${formatRelativeTime(group.lastRunAt)}` : "Never run"}
                </span>
              </button>
              {isExpanded &&
                group.runs.map((run, index) =>
                  renderJobRow(run, {
                    nested: true,
                    displayName: delegationRunLabel(run, index, group.runs.length),
                  }),
                )}
            </div>
          );
        })}
      </div>
    );
  };

  const hasFolders = groupedJobs.apps.length > 0;
  const hasRegularJobs =
    groupedJobs.apps.some(([, appJobs]) => appJobs.length > 0) ||
    groupedJobs.ungrouped.length > 0;
  const hasListContent = delegationGroups.length > 0 || hasRegularJobs;
  const isWorkflow = viewMode === "workflow";

  return (
    <div className={`jv2 ${isWorkflow ? "jv2--workflow" : ""}`}>
      <JobPermissionBanner />
      <CloudOnlyJobsBanner
        cloudStatus={cloudStatus}
        summariesById={cloudStatus?.summariesById ?? {}}
      />
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
              onClick={() => {
                setViewMode("list");
                if (selectedAppId === STANDALONE_WORKFLOW_ID) {
                  setSelectedAppId(null);
                }
              }}
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
              {unlinkedJobIds.length > 0 && (
                <button
                  className={`jv2-app-sidebar-item ${selectedAppId === STANDALONE_WORKFLOW_ID ? "jv2-app-sidebar-item--active" : ""}`}
                  title="Jobs not linked to a mini-app via data sources or folder name"
                  onClick={() => {
                    setSelectedAppId(STANDALONE_WORKFLOW_ID);
                    setWorkflowSelectedJobId(null);
                  }}
                >
                  <span className="jv2-app-sidebar-icon">📋</span>
                  <span className="jv2-app-sidebar-name">Ungrouped</span>
                  <span className="jv2-app-count">{unlinkedJobIds.length}</span>
                </button>
              )}
              {appChips.length === 0 && unlinkedJobIds.length === 0 && (
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
                seedJobIds={
                  selectedApp.appId === STANDALONE_WORKFLOW_ID
                    ? standaloneSeedJobIds
                    : undefined
                }
                restrictToJobIds={
                  selectedApp.appId === STANDALONE_WORKFLOW_ID
                    ? unlinkedJobIds
                    : graph.appLinks[selectedApp.appId]?.jobIds
                }
                showAppNode={selectedApp.appId !== STANDALONE_WORKFLOW_ID}
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
                  className={`jv2-app-trigger ${listAppFilterId ? "jv2-app-trigger--active" : ""}`}
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
                      className={`jv2-app-option ${!listAppFilterId ? "jv2-app-option--active" : ""}`}
                      onClick={() => { setSelectedAppId(null); setAppDropdownOpen(false); }}
                    >
                      All Apps
                      <span className="jv2-app-count">{jobs.length}</span>
                    </button>
                    {appChips.map(({ appId, name, count }) => (
                      <button
                        key={appId}
                        className={`jv2-app-option ${listAppFilterId === appId ? "jv2-app-option--active" : ""}`}
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
            <div className="jv2-filters jv2-filters--types">
              {JOB_TYPE_FILTER_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  className={typeFilter === value ? "jv2-filter jv2-filter--active" : "jv2-filter"}
                  onClick={() => setTypeFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="jv2-content">
            <div className="jv2-list">
              {loading && <p className="jv2-empty">Loading…</p>}
              {error && <p className="jv2-empty">{error}</p>}
              {!loading && !hasListContent && (
                <div className="jv2-empty">
                  <p>No matching jobs</p>
                </div>
              )}

              {renderDelegationSection()}

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

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div className="jv2-modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="jv2-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="jv2-modal-title">Delete Job</h3>
            <p className="jv2-modal-text">
              Are you sure you want to delete <strong>{deleteConfirm.jobName}</strong>?
            </p>
            <div className="jv2-modal-checkboxes">
              <label className="jv2-modal-checkbox">
                <input
                  type="checkbox"
                  checked={deleteConfirm.deleteFiles}
                  onChange={(e) =>
                    setDeleteConfirm((prev) =>
                      prev ? { ...prev, deleteFiles: e.target.checked } : prev,
                    )
                  }
                />
                <span>Delete local job files (scripts, logs, scratch database)</span>
              </label>
              <label className="jv2-modal-checkbox">
                <input
                  type="checkbox"
                  checked={deleteConfirm.deleteTursoDb}
                  onChange={(e) =>
                    setDeleteConfirm((prev) =>
                      prev ? { ...prev, deleteTursoDb: e.target.checked } : prev,
                    )
                  }
                />
                <span>Delete Turso cloud database for this job</span>
              </label>
            </div>
            <p className="jv2-modal-note">
              The cloud job catalog updates automatically when you delete — scheduled cloud runs
              stop for this job. Local-only jobs are never scheduled in the cloud.
            </p>
            <div className="jv2-modal-actions">
              <button
                className="jv2-modal-btn"
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="jv2-modal-btn jv2-modal-btn--danger"
                onClick={() => void handleDeleteJob(deleteConfirm.jobId)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
