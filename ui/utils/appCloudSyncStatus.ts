/**
 * Per-app cloud sync status derived from gateway /api/sync/items.
 */

import type { SyncItemsResponse } from "../components/Settings/CloudSyncDetails";

/** True when remote git log is cloud job status writebacks only (metadata, not app code). */
export function isRemoteJobStatusWritebackSummary(
  summary: string | null | undefined,
): boolean {
  if (!summary?.trim()) {
    return false;
  }
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  return lines.every((line) =>
    /^[0-9a-f]{7,40}\s+cloud:\s+update job .+ status$/i.test(line),
  );
}

export type AppCloudSyncOverall =
  | "synced"
  | "uploading"
  | "needs_sync"
  | "disabled"
  | "unknown";

/** @deprecated Use AppCloudSyncOverall — kept for gradual migration */
export type AppCloudSyncOverallLegacy = AppCloudSyncOverall | "syncing" | "outdated";

export type AppCloudCodeStatus =
  | "synced"
  | "pending"
  | "outdated"
  | "failed"
  | "updates_available"
  | "unknown";

export type AppCloudItemPhase =
  | "synced"
  | "uploading"
  | "not_uploaded"
  | "changed";

export interface AppCloudJobStatus {
  jobId: string;
  label: string;
  status: AppCloudCodeStatus;
  phase: AppCloudItemPhase;
  detail: string;
  lastError?: string | null;
  manualUploadHold?: boolean;
}

export interface AppCloudDatabaseStatus {
  alias: string;
  jobId: string;
  status: "synced" | "pending" | "empty" | "unavailable" | "quarantined";
  phase: AppCloudItemPhase;
  detail: string;
  manualUploadHold?: boolean;
}

export type AppCloudPublishStatus =
  | "synced"
  | "republishing"
  | "not_web_ready"
  | "drift"
  | "error";

export interface AppCloudSyncStatus {
  overall: AppCloudSyncOverall;
  codeStatus: AppCloudCodeStatus;
  codePhase: AppCloudItemPhase;
  codeLabel: string;
  dependentJobs: AppCloudJobStatus[];
  hasDependentJobs: boolean;
  syncedJobCount: number;
  totalJobCount: number;
  summaryLine: string;
  databases: AppCloudDatabaseStatus[];
  hasLinkedDatabases: boolean;
  hasRegistryDatabases: boolean;
  registryPhase: AppCloudItemPhase;
  registryLabel: string;
  chipLabel: string;
  globallySyncing: boolean;
  /** Auto-republish after git push (publish catalog / vault allowlist). */
  cloudPublishing: boolean;
  /** Cross-layer publish readiness (git + Turso + verify + convergence). */
  publishStatus: AppCloudPublishStatus;
  publishLabel: string;
  publishDetail: string | null;
  /** Coordinator upload progress (database → code → web check). */
  uploadStatus?: "idle" | "uploading" | "waiting" | "failed";
  uploadLabel?: string | null;
  uploadDetail?: string | null;
  uploadRetryPending?: boolean;
  /** Remote git commits exist that local has not merged yet. */
  gitUpdatesAvailable: boolean;
  gitUpdatesSummary: string | null;
  /** App/job source on remote — user must tap Merge remote changes. */
  gitRemoteRequiresReview: boolean;
  /** Cloud job status writebacks only — auto-integrating, no approval needed. */
  gitRemoteMetadataSync: boolean;
  /** e.g. "1 contributed code merge + 8 cloud job status updates" */
  gitRemoteReviewHeadline: string | null;
  codeLastError?: string | null;
}

const GIT_ACTIVE_STATUSES = new Set([
  "syncing",
  "queuing",
  "cloning",
  "pulling",
]);

function resolveItemPhase(
  status: AppCloudCodeStatus,
  _relativePath: string,
  _queuedPaths: ReadonlySet<string>,
  lastSyncAt: string | null,
): AppCloudItemPhase {
  if (status === "synced") return "synced";
  if (status === "updates_available") return "changed";
  if (status === "failed") return "changed";
  if (status === "outdated") return "changed";
  if (status === "pending" && !lastSyncAt) return "not_uploaded";
  if (status === "pending") return "changed";
  return "changed";
}

function codeDetail(
  phase: AppCloudItemPhase,
  status: AppCloudCodeStatus,
  manualUploadHold?: boolean,
  lastError?: string | null,
): string {
  if (status === "failed") {
    return lastError
      ? `Upload failed — ${lastError.slice(0, 120)}`
      : "Upload failed — retry in Settings → Cloud Sync";
  }
  if (status === "updates_available") {
    return "Cloud has newer app or job code — merge before uploading";
  }
  if (manualUploadHold && phase === "changed") {
    return "Local changes waiting — manual upload mode (click Upload now)";
  }
  switch (phase) {
    case "synced":
      return "App code is on the web";
    case "uploading":
      return "Uploading app code…";
    case "not_uploaded":
      return "App code not uploaded yet";
    case "changed":
      return "App code changed locally";
  }
}

function jobDetail(
  phase: AppCloudItemPhase,
  status: AppCloudCodeStatus,
  manualUploadHold?: boolean,
  lastError?: string | null,
): string {
  if (status === "failed") {
    return lastError
      ? `Failed — ${lastError.slice(0, 80)}`
      : "Upload failed";
  }
  if (status === "updates_available") {
    return "Cloud job status updating";
  }
  if (manualUploadHold && phase === "changed") {
    return "Waiting — manual upload mode";
  }
  switch (phase) {
    case "synced":
      return "On the web";
    case "uploading":
      return "Uploading…";
    case "not_uploaded":
      return "Not uploaded yet";
    case "changed":
      return "Changed locally";
  }
}

function databaseDetail(item: {
  alias: string;
  status: AppCloudDatabaseStatus["status"];
  localTableCount: number;
  remoteTableCount: number;
  schemaDrift?: boolean;
  quarantineReason?: string | null;
  manualUploadHold?: boolean;
}): string {
  switch (item.status) {
    case "synced":
      return `${item.remoteTableCount} table(s) on Turso`;
    case "pending":
      if (item.manualUploadHold) {
        return "Local changes waiting — manual upload mode (click Upload now)";
      }
      if (item.schemaDrift) {
        return "Local schema changed — click Upload now to update Turso";
      }
      return item.remoteTableCount > 0
        ? "Local changes waiting — click Upload now to push to Turso"
        : `${item.localTableCount} local table(s) not on Turso yet — click Upload now`;
    case "empty":
      return "No data tables yet";
    case "unavailable":
      return "Database file missing or unreadable";
    case "quarantined":
      return item.quarantineReason
        ? `Sync paused: ${item.quarantineReason.slice(0, 100)}`
        : "Sync paused — repair in Settings → Cloud Sync";
    default:
      return item.status;
  }
}

function databasePhase(
  status: AppCloudDatabaseStatus["status"],
): AppCloudItemPhase {
  switch (status) {
    case "synced":
    case "empty":
      return "synced";
    case "pending":
      return "changed";
    case "quarantined":
    case "unavailable":
      return "changed";
    default:
      return "changed";
  }
}

function publishDetailLabel(
  status: AppCloudPublishStatus,
  detail: string | null,
): string {
  switch (status) {
    case "synced":
      return detail ?? "Live app matches local code and databases";
    case "republishing":
      return detail ?? "Updating publish catalog…";
    case "not_web_ready":
      return detail ?? "Code or databases still syncing — web app may show stale data";
    case "drift":
      return detail ?? "Local and Turso row counts differ — click Upload now";
    case "error":
      return detail ?? "Publish readiness check failed";
    default:
      return detail ?? "Publish status unknown";
  }
}

function publishChipLabel(status: AppCloudPublishStatus): string | null {
  switch (status) {
    case "not_web_ready":
      return "Not ready for web";
    case "drift":
      return "Data drift";
    case "error":
      return "Publish check failed";
    default:
      return null;
  }
}

function buildSummaryLine(opts: {
  codePhase: AppCloudItemPhase;
  syncedJobCount: number;
  totalJobCount: number;
  dbPending: number;
  registryNeedsSync: boolean;
  isUploading: boolean;
  publishStatus?: AppCloudPublishStatus;
  publishDetail?: string | null;
  gitRemoteRequiresReview?: boolean;
  gitRemoteMetadataSync?: boolean;
}): string {
  const {
    codePhase,
    syncedJobCount,
    totalJobCount,
    dbPending,
    registryNeedsSync,
    isUploading,
    publishStatus,
    publishDetail,
    gitRemoteRequiresReview,
    gitRemoteMetadataSync,
  } = opts;

  if (gitRemoteMetadataSync) {
    return "Syncing cloud job status…";
  }
  if (gitRemoteRequiresReview) {
    return "Merge cloud changes before upload";
  }

  if (isUploading) {
    if (totalJobCount > 0) {
      return `Uploading app and jobs (${syncedJobCount}/${totalJobCount} already on web)…`;
    }
    return "Uploading app to the web…";
  }

  const parts: string[] = [];
  if (totalJobCount > 0) {
    parts.push(`${syncedJobCount} of ${totalJobCount} jobs on the web`);
  }
  if (codePhase === "not_uploaded") {
    parts.push("app code not uploaded yet");
  } else if (codePhase === "changed") {
    parts.push("app code changed locally");
  }
  if (registryNeedsSync) {
    parts.push(
      codePhase === "not_uploaded"
        ? "database registry not on web yet"
        : "database registry will upload with app code",
    );
  }
  if (dbPending > 0) {
    parts.push(`${dbPending} database(s) waiting for Turso upload`);
  }
  if (publishStatus === "not_web_ready" || publishStatus === "drift") {
    parts.push(publishDetailLabel(publishStatus, publishDetail ?? null));
  }
  if (parts.length === 0) {
    return "Everything for this app matches the web";
  }
  return parts.join(" · ");
}

export function deriveAppCloudSyncStatus(
  appId: string,
  items: SyncItemsResponse | null,
  gitGlobalStatus?: string | null,
  options?: {
    dependentJobIds?: readonly string[];
    registryDbIds?: readonly string[];
    isUploading?: boolean;
    cloudPublishing?: boolean;
  },
): AppCloudSyncStatus {
  const isUploading = options?.isUploading === true;
  const cloudPublishing = options?.cloudPublishing === true;

  if (!items?.enabled) {
    return {
      overall: "disabled",
      codeStatus: "unknown",
      codePhase: "changed",
      codeLabel: "Cloud sync is off",
      dependentJobs: [],
      hasDependentJobs: false,
      syncedJobCount: 0,
      totalJobCount: 0,
      summaryLine: "Cloud sync is off",
      databases: [],
      hasLinkedDatabases: false,
      hasRegistryDatabases: false,
      registryPhase: "changed",
      registryLabel: "Database registry not checked",
      chipLabel: "Cloud off",
      globallySyncing: false,
      cloudPublishing: false,
      publishStatus: "synced",
      publishLabel: "Cloud sync is off",
      publishDetail: null,
      gitUpdatesAvailable: false,
      gitUpdatesSummary: null,
      gitRemoteRequiresReview: false,
      gitRemoteMetadataSync: false,
      gitRemoteReviewHeadline: null,
    };
  }

  const gitUpdatesAvailable = items.github?.gitUpdatesAvailable === true;
  const gitUpdatesSummary = items.github?.gitUpdatesSummary ?? null;
  const gitRemoteRequiresReview =
    items.github?.gitRemoteRequiresReview === true;
  const gitRemoteMetadataSync = items.github?.gitRemoteMetadataSync === true;
  const gitRemoteReviewHeadline =
    items.github?.gitRemoteReviewHeadline ?? null;
  const globallySyncing = GIT_ACTIVE_STATUSES.has(gitGlobalStatus ?? "");
  const queuedPaths = new Set(items.github?.queuedPaths ?? []);
  const appPath = `apps/${appId}`;
  const githubItem = items.github?.apps.find(
    (item) => item.relativePath === appPath,
  );

  let codeStatus: AppCloudCodeStatus = "unknown";
  if (githubItem) {
    codeStatus = githubItem.status;
  }
  const codePhase = resolveItemPhase(
    codeStatus,
    appPath,
    queuedPaths,
    githubItem?.lastSyncAt ?? null,
  );
  if (isUploading && codePhase !== "synced") {
    // Client-side push in flight — show active upload for non-synced items.
  }

  const jobIdSet = new Set(
    options?.dependentJobIds ?? items.appContext?.dependentJobIds ?? [],
  );
  const dependentJobs: AppCloudJobStatus[] = (items.github?.jobs ?? [])
    .filter((job) => jobIdSet.has(job.id))
    .map((job) => {
      let phase = resolveItemPhase(
        job.status,
        job.relativePath,
        queuedPaths,
        job.lastSyncAt,
      );
      if (isUploading && phase !== "synced") {
        phase = "uploading";
      }
      return {
        jobId: job.id,
        label: job.label,
        status: job.status,
        phase,
        detail:
          gitRemoteMetadataSync && job.status === "updates_available"
            ? "Integrating cloud job status…"
            : jobDetail(phase, job.status, job.manualUploadHold, job.lastError),
        lastError: job.lastError,
        manualUploadHold: job.manualUploadHold,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const databases: AppCloudDatabaseStatus[] = (items.turso?.sources ?? [])
    .filter((source) => source.appId === appId)
    .map((source) => {
      const phase = databasePhase(source.status);
      return {
        alias: source.alias,
        jobId: source.jobId,
        status: source.status,
        phase,
        detail: databaseDetail({
          alias: source.alias,
          status: source.status,
          localTableCount: source.localTableCount,
          remoteTableCount: source.remoteTableCount,
          schemaDrift: source.schemaDrift,
          quarantineReason: source.quarantineReason,
          manualUploadHold: source.manualUploadHold,
        }),
        manualUploadHold: source.manualUploadHold,
      };
    });

  const hasLinkedDatabases = databases.length > 0;
  const hasDependentJobs = dependentJobs.length > 0;
  const syncedJobCount = dependentJobs.filter((job) => job.phase === "synced").length;
  const totalJobCount = dependentJobs.length;
  const dbPending = databases.filter(
    (db) => db.status === "pending" || db.status === "quarantined",
  ).length;

  const registryDbIds =
    options?.registryDbIds ?? items.appContext?.registryDbIds ?? [];
  const hasRegistryDatabases = registryDbIds.length > 0;
  // Registry ships beside data-sources.json as apps/{id}/linked-databases.json.
  let registryPhase: AppCloudItemPhase = "synced";
  if (!hasRegistryDatabases) {
    registryPhase = "synced";
  } else if (codePhase === "synced") {
    registryPhase = "synced";
  } else if (isUploading || codePhase === "uploading") {
    registryPhase = "uploading";
  } else if (codePhase === "not_uploaded") {
    registryPhase = "not_uploaded";
  } else {
    registryPhase = "changed";
  }
  const registryNeedsSync = hasRegistryDatabases && registryPhase !== "synced";
  const registryLabel = !hasRegistryDatabases
    ? "No registry databases"
    : registryPhase === "synced"
      ? "Registry on the web"
      : codePhase === "not_uploaded"
        ? "Registry not on web yet"
        : "Registry uploads with app code";

  const codePhaseDisplay =
    isUploading && codePhase !== "synced" ? "uploading" : codePhase;
  const codeLabel = codeDetail(
    codePhaseDisplay,
    codeStatus,
    githubItem?.manualUploadHold,
    githubItem?.lastError,
  );

  const publishStatus: AppCloudPublishStatus =
    items.publish?.status ??
    (cloudPublishing ? "republishing" : "synced");
  const publishDetail = items.publish?.detail ?? null;
  const publishLabel = publishDetailLabel(publishStatus, publishDetail);
  const publishBlocksWeb =
    publishStatus === "not_web_ready" ||
    publishStatus === "drift" ||
    publishStatus === "error";

  const uploadStatus = items.upload?.status;
  const uploadLabel = items.upload?.label ?? null;
  const uploadDetail = items.upload?.detail ?? null;
  const uploadRetryPending = items.upload?.retryPending ?? false;
  const coordinatorUploading = uploadStatus === "uploading";
  const coordinatorFailed = uploadStatus === "failed";

  const anyUploading =
    isUploading ||
    coordinatorUploading ||
    uploadRetryPending ||
    codePhaseDisplay === "uploading" ||
    dependentJobs.some((job) => job.phase === "uploading");

  const needsSync =
    codePhase === "changed" ||
    codePhase === "not_uploaded" ||
    codeStatus === "failed" ||
    coordinatorFailed ||
    dependentJobs.some(
      (job) =>
        job.phase === "changed" ||
        job.phase === "not_uploaded" ||
        job.status === "failed",
    ) ||
    dbPending > 0 ||
    registryNeedsSync;

  let overall: AppCloudSyncOverall = "unknown";
  if (anyUploading) {
    overall = "uploading";
  } else if (
    gitRemoteRequiresReview ||
    needsSync ||
    publishBlocksWeb ||
    codePhaseDisplay === "changed" ||
    codePhaseDisplay === "not_uploaded"
  ) {
    overall = "needs_sync";
  } else if (gitRemoteMetadataSync) {
    overall = "uploading";
  } else if (
    codePhaseDisplay === "synced" &&
    dependentJobs.every((job) => job.phase === "synced") &&
    dbPending === 0 &&
    !registryNeedsSync
  ) {
    overall = "synced";
  }

  let chipLabel = "Sync status";
  if (coordinatorFailed && !uploadRetryPending) {
    chipLabel = "Upload failed";
  } else if (codeStatus === "failed") {
    chipLabel = "Upload failed";
  } else if (gitRemoteRequiresReview) {
    chipLabel = "Merge required";
  } else if (gitRemoteMetadataSync) {
    chipLabel = "Syncing job status…";
  } else if (cloudPublishing || publishStatus === "republishing") {
    chipLabel = "Updating cloud…";
  } else if (coordinatorUploading && uploadLabel) {
    chipLabel = uploadLabel;
  } else if (overall === "synced") {
    const publishChip = publishChipLabel(publishStatus);
    chipLabel = publishChip ?? "Synced";
  } else if (overall === "uploading") {
    chipLabel =
      totalJobCount > 0
        ? `Uploading ${syncedJobCount}/${totalJobCount}…`
        : "Uploading…";
  } else if (overall === "needs_sync") {
    const publishChip = publishChipLabel(publishStatus);
    chipLabel =
      publishChip ??
      (totalJobCount > 0
        ? `Needs sync (${syncedJobCount}/${totalJobCount})`
        : "Needs sync");
  } else if (overall === "unknown") chipLabel = "Sync status unknown";

  const summaryLine =
    overall === "unknown"
      ? "Could not determine web sync status — open for details"
      : buildSummaryLine({
          codePhase: codePhaseDisplay,
          syncedJobCount,
          totalJobCount,
          dbPending,
          registryNeedsSync,
          isUploading: anyUploading,
          publishStatus,
          publishDetail,
          gitRemoteRequiresReview,
          gitRemoteMetadataSync,
        });

  return {
    overall,
    codeStatus,
    codePhase: codePhaseDisplay,
    codeLabel,
    dependentJobs,
    hasDependentJobs,
    syncedJobCount,
    totalJobCount,
    summaryLine,
    databases,
    hasLinkedDatabases,
    hasRegistryDatabases,
    registryPhase,
    registryLabel,
    chipLabel,
    globallySyncing,
    cloudPublishing,
    publishStatus,
    publishLabel,
    publishDetail,
    uploadStatus,
    uploadLabel,
    uploadDetail,
    uploadRetryPending,
    gitUpdatesAvailable,
    gitUpdatesSummary,
    gitRemoteRequiresReview,
    gitRemoteMetadataSync,
    gitRemoteReviewHeadline,
    codeLastError: githubItem?.lastError ?? null,
  };
}

export type WebSyncVisualState =
  | "loading"
  | "synced"
  | "syncing"
  | "warn"
  | "action_required"
  | "disabled"
  | "error";

/** Hover tooltip for the web sync status dot. */
export function formatWebSyncStatusTooltip(
  status: AppCloudSyncStatus | null,
  options: { loading?: boolean; error?: string | null; refreshing?: boolean } = {},
): string {
  if (options.error) {
    return options.error.length > 0
      ? `Web sync unavailable — ${options.error}`
      : "Web sync unavailable";
  }
  if (options.loading || !status) return "Checking what's on the web…";
  if (status.gitRemoteRequiresReview) {
    return "Action needed — merge cloud changes before upload";
  }
  if (status.gitRemoteMetadataSync) {
    return "Integrating cloud job status — no action needed";
  }
  if (status.overall === "disabled") {
    return "Cloud sync is off — turn on in Settings → Cloud Sync";
  }
  if (status.overall === "unknown") {
    return status.summaryLine || "Sync status unknown — click for details";
  }
  return status.summaryLine || status.chipLabel;
}

export function webSyncVisualState(
  status: AppCloudSyncStatus | null,
  options: {
    loading?: boolean;
    error?: string | null;
    pushing?: boolean;
    refreshing?: boolean;
  } = {},
): WebSyncVisualState {
  if (options.error) return "error";
  if (options.loading || !status) return "loading";
  if (status.overall === "disabled") return "disabled";
  if (status.codeStatus === "failed") return "error";
  if (status.gitRemoteRequiresReview) return "action_required";
  if (options.pushing || status.overall === "uploading") return "syncing";
  if (
    status.publishStatus === "not_web_ready" ||
    status.publishStatus === "drift" ||
    status.publishStatus === "error"
  ) {
    return "warn";
  }
  if (status.overall === "synced") return "synced";
  if (status.overall === "needs_sync" || status.overall === "unknown") {
    return "warn";
  }
  return "warn";
}

export interface PublishBarStatusInput {
  live: boolean;
  loading: boolean;
  refreshing: boolean;
  syncEnabled: boolean;
  webSyncState: WebSyncVisualState;
  webSyncSpinning: boolean;
  webSyncTooltip: string;
}

/** Single publish-bar status: combines live/publish state with web sync when previewing. */
export function resolvePublishBarStatus(input: PublishBarStatusInput): {
  state: WebSyncVisualState;
  spinning: boolean;
  tooltip: string;
  interactive: boolean;
} {
  const {
    live,
    loading,
    refreshing,
    syncEnabled,
    webSyncState,
    webSyncSpinning,
    webSyncTooltip,
  } = input;

  if (!syncEnabled) {
    if (loading && !live) {
      return {
        state: "loading",
        spinning: false,
        tooltip: "Checking publish status…",
        interactive: false,
      };
    }
    if (!live) {
      return {
        state: "disabled",
        spinning: false,
        tooltip: "Draft — not published to the web",
        interactive: false,
      };
    }
    if (refreshing) {
      return {
        state: "syncing",
        spinning: true,
        tooltip: "Updating live app…",
        interactive: false,
      };
    }
    return {
      state: "synced",
      spinning: false,
      tooltip: "Live on the web",
      interactive: false,
    };
  }

  if (!live) {
    return {
      state: "disabled",
      spinning: false,
      tooltip: "Draft — publish to the web to sync",
      interactive: true,
    };
  }

  const spinning = webSyncSpinning || refreshing;
  const tooltip =
    refreshing && webSyncState === "synced"
      ? "Updating live app…"
      : webSyncTooltip;

  return {
    state: webSyncState,
    spinning,
    tooltip,
    interactive: true,
  };
}
