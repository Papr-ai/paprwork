import type { JobRecord } from "../../hooks/useJobs";
import type {
  CloudJobSummary,
  JobCloudStatusReport,
  JobExecutionPlacement,
} from "./jobCloudTypes";
import "./JobCloudSection.css";

const PLACEMENT_OPTIONS: Array<{
  value: JobExecutionPlacement;
  label: string;
  hint: string;
}> = [
  {
    value: "local-preferred",
    label: "Local preferred",
    hint: "Runs on this Mac when awake; cloud when asleep",
  },
  {
    value: "cloud-preferred",
    label: "Cloud preferred",
    hint: "Scheduled runs go to Papr Cloud (desktop defers)",
  },
  {
    value: "local-only",
    label: "Local only",
    hint: "Never scheduled in the cloud — this device only",
  },
];

function formatRelativeTime(iso?: string): string {
  if (!iso) return "Never";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "Never";
  const diffSec = Math.round((Date.now() - ms) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function formatRunSource(source?: string): string {
  if (!source) return "Unknown";
  if (source === "desktop") return "This Mac";
  if (source === "cloud_scheduler") return "Cloud scheduler";
  if (source === "cloud_manual") return "Cloud (manual)";
  if (source.startsWith("cloud")) return "Cloud";
  return source.replace(/_/g, " ");
}

function normalizePlacement(job: JobRecord): JobExecutionPlacement {
  const cap = job.executionCapability;
  if (cap === "local-only") return "local-only";
  if (cap === "cloud-preferred") return "cloud-preferred";
  return "local-preferred";
}

interface JobCloudSectionProps {
  job: JobRecord;
  cloudStatus: JobCloudStatusReport | null;
  cloudSummary?: CloudJobSummary;
  updatingPlacement: boolean;
  onPlacementChange: (placement: JobExecutionPlacement) => void;
  onRefreshCloud: () => void;
}

export function JobCloudSection({
  job,
  cloudStatus,
  cloudSummary,
  updatingPlacement,
  onPlacementChange,
  onRefreshCloud,
}: JobCloudSectionProps) {
  const connected = cloudStatus?.connected ?? false;
  const registeredInCloud = Boolean(cloudSummary);
  const placement = normalizePlacement(job);
  const cloudSchedulerActive = cloudStatus?.cloudSchedulerActive ?? false;

  const cloudLastRun = cloudSummary?.lastRunAt;
  const cloudStatusLabel = cloudSummary?.status;
  const localLastRun = job.lastRunAt;
  const runsDiffer =
    cloudLastRun &&
    localLastRun &&
    Math.abs(Date.parse(cloudLastRun) - Date.parse(localLastRun)) > 5000;

  if (!connected) {
    return (
      <div className="jv2-cloud-section jv2-cloud-section--muted">
        <div className="jv2-cloud-section-header">
          <CloudIcon />
          <span className="jv2-cloud-section-title">Cloud</span>
        </div>
        <p className="jv2-cloud-hint">
          Sign in to Papr to see cloud job status and control scheduled execution.
        </p>
      </div>
    );
  }

  return (
    <div className="jv2-cloud-section">
      <div className="jv2-cloud-section-header">
        <CloudIcon />
        <span className="jv2-cloud-section-title">Cloud</span>
        <button
          type="button"
          className="jv2-btn-text jv2-cloud-refresh"
          onClick={onRefreshCloud}
          title="Refresh cloud status"
        >
          Refresh
        </button>
      </div>

      <div className="jv2-detail-grid jv2-cloud-grid">
        <div className="jv2-detail-cell">
          <span className="jv2-detail-label">Cloud catalog</span>
          <span
            className={`jv2-detail-value ${registeredInCloud ? "jv2-cloud-ok" : "jv2-cloud-warn"}`}
          >
            {registeredInCloud ? "Registered" : "Not synced"}
          </span>
        </div>
        <div className="jv2-detail-cell">
          <span className="jv2-detail-label">Last run source</span>
          <span className="jv2-detail-value">{formatRunSource(job.lastRunSource)}</span>
        </div>
        <div className="jv2-detail-cell">
          <span className="jv2-detail-label">Last run (local)</span>
          <span className="jv2-detail-value">{formatRelativeTime(localLastRun)}</span>
        </div>
        {registeredInCloud && (
          <>
            <div className="jv2-detail-cell">
              <span className="jv2-detail-label">Last run (cloud)</span>
              <span className="jv2-detail-value">{formatRelativeTime(cloudLastRun)}</span>
            </div>
            {cloudStatusLabel && (
              <div className="jv2-detail-cell">
                <span className="jv2-detail-label">Cloud status</span>
                <span className="jv2-detail-value">{cloudStatusLabel}</span>
              </div>
            )}
          </>
        )}
      </div>

      {runsDiffer && (
        <p className="jv2-cloud-hint">
          Cloud and local last-run times differ — the job may have run on Papr Cloud while this Mac
          was asleep.
        </p>
      )}

      {cloudSchedulerActive && job.schedule?.enabled && placement !== "local-only" && (
        <p className="jv2-cloud-hint jv2-cloud-hint--info">
          Cloud scheduler is active. When this Mac is awake,{" "}
          {placement === "cloud-preferred"
            ? "scheduled runs still go to the cloud."
            : "this job runs locally; cloud runs when asleep."}
        </p>
      )}

      <div className="jv2-cloud-placement">
        <span className="jv2-detail-label">Scheduled execution</span>
        <div className="jv2-cloud-placement-options">
          {PLACEMENT_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`jv2-cloud-placement-option ${placement === opt.value ? "jv2-cloud-placement-option--active" : ""}`}
            >
              <input
                type="radio"
                name={`cloud-placement-${job.id}`}
                value={opt.value}
                checked={placement === opt.value}
                disabled={updatingPlacement}
                onChange={() => onPlacementChange(opt.value)}
              />
              <span className="jv2-cloud-placement-label">{opt.label}</span>
              <span className="jv2-cloud-placement-hint">{opt.hint}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function CloudIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 18h11a4 4 0 000-8 5 5 0 00-9.8-1.2A3.5 3.5 0 007 18z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function CloudOnlyJobsBanner({
  cloudStatus,
  summariesById,
}: {
  cloudStatus: JobCloudStatusReport | null;
  summariesById: Record<string, CloudJobSummary>;
}) {
  if (!cloudStatus?.connected || cloudStatus.cloudOnlyJobIds.length === 0) {
    return null;
  }

  const names = cloudStatus.cloudOnlyJobIds
    .slice(0, 3)
    .map((id) => summariesById[id]?.name ?? id.slice(0, 8))
    .join(", ");
  const extra =
    cloudStatus.cloudOnlyJobIds.length > 3
      ? ` +${cloudStatus.cloudOnlyJobIds.length - 3} more`
      : "";

  return (
    <div className="jv2-cloud-banner">
      <CloudIcon />
      <span>
        {cloudStatus.cloudOnlyJobIds.length} job
        {cloudStatus.cloudOnlyJobIds.length === 1 ? "" : "s"} in your cloud catalog not on this
        device ({names}
        {extra}). Deleting locally removes the job from git and the cloud catalog; if entries
        linger, use Refresh or delete again after sync completes.
      </span>
    </div>
  );
}
