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
  /** Local SQLite schema differs from Turso — blocks web-ready until healed. */
  schemaDrift?: boolean;
  /** True when row-level CDC is catching up but replica already exists. */
  rowsSyncing?: boolean;
  /** Plan A Turso Sync replica path. */
  syncMode?: "legacy" | "replica";
  online?: boolean;
  pendingPush?: boolean;
  pendingOps?: number;
  migrationConflict?: boolean;
  lastReplicaPushError?: string | null;
  cutoverBlocked?: boolean;
  cutoverBlockReason?: string | null;
}

/** Pending DB work that should block the green "Synced" chip. */
function databaseBlocksOverallSync(input: {
  status: AppCloudDatabaseStatus["status"];
  schemaDrift?: boolean;
  remoteTableCount?: number;
  manualUploadHold?: boolean;
  syncMode?: "legacy" | "replica";
  pendingPush?: boolean;
  migrationConflict?: boolean;
  cutoverBlocked?: boolean;
}): boolean {
  if (input.status === "quarantined" || input.status === "unavailable") {
    return true;
  }
  if (input.syncMode === "replica") {
    if (input.migrationConflict || input.cutoverBlocked) {
      return true;
    }
    if (input.pendingPush) {
      return true;
    }
    if (input.manualUploadHold) {
      return true;
    }
    return false;
  }
  if (input.status !== "pending") {
    return false;
  }
  if (input.manualUploadHold) {
    return true;
  }
  if (input.schemaDrift) {
    return true;
  }
  // Row-level dirty with an existing Turso replica — background CDC, not a chip blocker.
  if ((input.remoteTableCount ?? 0) > 0) {
    return false;
  }
  return true;
}

export type AppCloudPublishStatus =
  | "synced"
  | "republishing"
  | "not_web_ready"
  | "drift"
  | "error";

export function formatLastUploadedAt(isoStr: string | null | undefined): string | null {
  if (!isoStr) {
    return null;
  }
  const diff = Date.now() - new Date(isoStr).getTime();
  if (Number.isNaN(diff)) {
    return null;
  }
  if (diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export interface AppCloudSyncStatus {
  overall: AppCloudSyncOverall;
  codeStatus: AppCloudCodeStatus;
  codePhase: AppCloudItemPhase;
  codeLabel: string;
  /** Most recent git upload timestamp for this app's code folder. */
  lastUploadedAt: string | null;
  dependentJobs: AppCloudJobStatus[];
  hasDependentJobs: boolean;
  syncedJobCount: number;
  totalJobCount: number;
  summaryLine: string;
  databases: AppCloudDatabaseStatus[];
  /** True when any linked DB has local/remote schema drift blocking web sync. */
  hasSchemaDrift: boolean;
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
  /** Waiting in global flush queue (not actively uploading yet). */
  uploadQueued?: boolean;
  uploadQueuePosition?: number | null;
  uploadQueueDepth?: number | null;
  /** Remote git commits exist that local has not merged yet. */
  gitUpdatesAvailable: boolean;
  gitUpdatesSummary: string | null;
  /** App-repo writer 409 — parentHash mismatch; merge or reconcile before re-upload. */
  writerConflict: boolean;
  /** App/job source on remote — user must tap Merge remote changes. */
  gitRemoteRequiresReview: boolean;
  /** Cloud job status writebacks only — auto-integrating, no approval needed. */
  gitRemoteMetadataSync: boolean;
  /** e.g. "1 contributed code merge + 8 cloud job status updates" */
  gitRemoteReviewHeadline: string | null;
  codeLastError?: string | null;
  /** App has an active Papr cloud share link — local git/Turso lag should not block UI. */
  publishLive?: boolean;
  /** Files in the app folder over 10MB — git sync skips them; use App Files. */
  oversizedAppFilesMessage?: string | null;
  oversizedAppFilesCount?: number;
}

const GIT_ACTIVE_STATUSES = new Set([
  "syncing",
  "queuing",
  "cloning",
  "pulling",
]);

function mapAppSyncV3ToCodeStatus(
  status: NonNullable<SyncItemsResponse["appSync"]>["status"],
): AppCloudCodeStatus {
  switch (status) {
    case "synced":
      return "synced";
    case "uploading":
    case "pending":
    case "not_uploaded":
      return "pending";
    case "failed":
    case "conflict":
      return "failed";
    default:
      return "unknown";
  }
}

function registryLabelForAppSync(
  hasRegistryDatabases: boolean,
  codePhase: AppCloudItemPhase,
): string {
  if (!hasRegistryDatabases) {
    return "No registry databases";
  }
  if (codePhase === "synced") {
    return "Registry on the web";
  }
  if (codePhase === "not_uploaded") {
    return "Registry not on web yet";
  }
  if (codePhase === "uploading") {
    return "Registry uploading with app code";
  }
  return "Registry uploads with app code";
}

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
  syncMode?: "legacy" | "replica";
  online?: boolean;
  pendingPush?: boolean;
  pendingOps?: number;
  migrationConflict?: boolean;
  lastReplicaPushError?: string | null;
  cutoverBlocked?: boolean;
  cutoverBlockReason?: string | null;
}): string {
  if (item.syncMode === "replica") {
    if (item.migrationConflict) {
      return (
        item.lastReplicaPushError?.slice(0, 120) ??
        "Migration conflict — reconcile migrations, then Upload now"
      );
    }
    if (item.cutoverBlocked) {
      return (
        item.cutoverBlockReason?.slice(0, 120) ??
        "Replica cutover blocked — check Settings → Cloud Sync"
      );
    }
    if (item.status === "pending" && item.pendingPush) {
      if (item.online === false) {
        return `Offline — ${item.pendingOps ?? 0} local change(s) will push when back online`;
      }
      return `Local changes not pushed to Turso yet (${item.pendingOps ?? 0} pending) — click Upload now`;
    }
    if (item.status === "synced") {
      return `${item.remoteTableCount} table(s) on Turso (replica)`;
    }
  }
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
      if (item.remoteTableCount > 0) {
        return "Row changes syncing to Turso in the background";
      }
      return `${item.localTableCount} local table(s) not on Turso yet — click Upload now`;
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
  dbBlockingPending: number;
  dbRowsSyncing: number;
  registryNeedsSync: boolean;
  isActivelyUploading: boolean;
  isQueuedForUpload: boolean;
  uploadQueuePosition?: number | null;
  uploadQueueDepth?: number | null;
  overall: AppCloudSyncOverall;
  lastUploadedAt: string | null;
  publishStatus?: AppCloudPublishStatus;
  publishDetail?: string | null;
  gitRemoteRequiresReview?: boolean;
  gitRemoteMetadataSync?: boolean;
  uploadLabel?: string | null;
}): string {
  const {
    codePhase,
    syncedJobCount,
    totalJobCount,
    dbBlockingPending,
    dbRowsSyncing,
    registryNeedsSync,
    isActivelyUploading,
    isQueuedForUpload,
    uploadQueuePosition,
    uploadQueueDepth,
    overall,
    lastUploadedAt,
    publishStatus,
    publishDetail,
    gitRemoteRequiresReview,
    gitRemoteMetadataSync,
    uploadLabel,
  } = opts;

  if (gitRemoteMetadataSync) {
    return "Syncing cloud job status…";
  }
  if (gitRemoteRequiresReview) {
    return "Merge cloud changes before upload";
  }

  if (isQueuedForUpload) {
    if (uploadLabel?.trim()) {
      return uploadLabel;
    }
    if (
      uploadQueuePosition != null &&
      uploadQueueDepth != null &&
      uploadQueueDepth > 1
    ) {
      return `In upload queue (${uploadQueuePosition} of ${uploadQueueDepth})…`;
    }
    return "Waiting in upload queue…";
  }

  if (isActivelyUploading) {
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
    parts.push("local app changes not on web yet");
  }
  if (registryNeedsSync) {
    parts.push(
      codePhase === "not_uploaded"
        ? "database registry not on web yet"
        : "database registry will upload with app code",
    );
  }
  if (dbBlockingPending > 0) {
    parts.push(`${dbBlockingPending} database(s) waiting for Turso upload`);
  } else if (dbRowsSyncing > 0) {
    parts.push(`${dbRowsSyncing} database(s) syncing row changes in the background`);
  }
  if (publishStatus === "not_web_ready" || publishStatus === "drift") {
    parts.push(publishDetailLabel(publishStatus, publishDetail ?? null));
  }
  if (parts.length === 0) {
    if (overall === "synced") {
      const relative = formatLastUploadedAt(lastUploadedAt);
      return relative
        ? `Last uploaded ${relative}`
        : "Everything for this app matches the web";
    }
    if (overall === "uploading") {
      return "Uploading app to the web…";
    }
    if (overall === "needs_sync") {
      if (publishStatus === "error") {
        return publishDetailLabel("error", publishDetail ?? null);
      }
      return "Some changes still need to sync to the web";
    }
    return "Checking web sync status…";
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
    refreshing?: boolean;
  },
): AppCloudSyncStatus {
  const isUploading = options?.isUploading === true;
  const refreshing = options?.refreshing === true;

  if (!items?.enabled) {
    return {
      overall: "disabled",
      codeStatus: "unknown",
      codePhase: "changed",
      codeLabel: "Cloud sync is off",
      lastUploadedAt: null,
      dependentJobs: [],
      hasDependentJobs: false,
      syncedJobCount: 0,
      totalJobCount: 0,
      summaryLine: "Cloud sync is off",
      databases: [],
      hasSchemaDrift: false,
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
      oversizedAppFilesMessage: null,
      oversizedAppFilesCount: 0,
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
  const uploadQueuedEarly = items.upload?.waitingReason === "queued";
  const clientPushActive = isUploading && !uploadQueuedEarly;
  const appPath = `apps/${appId}`;
  const appSync = items.appSync ?? null;
  const writerConflict = appSync?.status === "conflict";
  const githubItem = items.github?.apps.find(
    (item) => item.relativePath === appPath,
  );

  let codeStatus: AppCloudCodeStatus = "unknown";
  let codePhase: AppCloudItemPhase = "changed";
  let codeLabel = "Sync status unknown";
  let codeLastError: string | null | undefined;

  if (appSync) {
    codeStatus = mapAppSyncV3ToCodeStatus(appSync.status);
    codePhase = appSync.phase;
    codeLabel = appSync.detail;
    codeLastError = appSync.lastError ?? null;
    if (clientPushActive && codePhase !== "synced" && appSync.status === "uploading") {
      codePhase = "uploading";
    }
  } else if (githubItem) {
    codeStatus = githubItem.status;
    codePhase = resolveItemPhase(
      codeStatus,
      appPath,
      queuedPaths,
      githubItem.lastSyncAt ?? null,
    );
    codeLabel = codeDetail(
      codePhase,
      codeStatus,
      githubItem.manualUploadHold,
      githubItem.lastError,
    );
    codeLastError = githubItem.lastError;
  }

  const jobIdSet = new Set(
    options?.dependentJobIds ?? items.appContext?.dependentJobIds ?? [],
  );
  const seenDependentJobIds = new Set<string>();
  const dependentJobsRaw: AppCloudJobStatus[] = (items.github?.jobs ?? [])
    .filter((job) => jobIdSet.has(job.id))
    .filter((job) => {
      if (seenDependentJobIds.has(job.id)) {
        return false;
      }
      seenDependentJobIds.add(job.id);
      return true;
    })
    .map((job) => {
      let phase = resolveItemPhase(
        job.status,
        job.relativePath,
        queuedPaths,
        job.lastSyncAt,
      );
      if (appSync && appSync.phase !== "synced" && phase === "synced") {
        phase = appSync.phase === "not_uploaded" ? "not_uploaded" : "changed";
      }
      if (isUploading && phase !== "synced") {
        phase = "uploading";
      }
      const detail =
        appSync && appSync.phase !== "synced" && phase !== "synced"
          ? "Uploads with app code via cloud repo"
          : gitRemoteMetadataSync && job.status === "updates_available"
            ? "Integrating cloud job status…"
            : jobDetail(phase, job.status, job.manualUploadHold, job.lastError);
      return {
        jobId: job.id,
        label: job.label,
        status: job.status,
        phase,
        detail,
        lastError: job.lastError,
        manualUploadHold: job.manualUploadHold,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const labelCounts = new Map<string, number>();
  for (const job of dependentJobsRaw) {
    labelCounts.set(job.label, (labelCounts.get(job.label) ?? 0) + 1);
  }
  const dependentJobs = dependentJobsRaw.map((job) => {
    if ((labelCounts.get(job.label) ?? 0) <= 1) {
      return job;
    }
    return {
      ...job,
      label: `${job.label} (${job.jobId.slice(0, 8)})`,
    };
  });

  const databases: AppCloudDatabaseStatus[] = (items.turso?.sources ?? [])
    .filter((source) => source.appId === appId)
    .map((source) => {
      const isReplica = source.syncMode === "replica";
      const blocksOverall = databaseBlocksOverallSync({
        status: source.status,
        schemaDrift: source.schemaDrift,
        remoteTableCount: source.remoteTableCount,
        manualUploadHold: source.manualUploadHold,
        syncMode: source.syncMode,
        pendingPush: source.pendingPush,
        migrationConflict: source.migrationConflict,
        cutoverBlocked: source.cutoverBlocked,
      });
      const rowsSyncing =
        !isReplica &&
        source.status === "pending" &&
        !blocksOverall &&
        (source.remoteTableCount ?? 0) > 0;
      const phase = rowsSyncing ? "synced" : databasePhase(source.status);
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
          syncMode: source.syncMode,
          online: source.online,
          pendingPush: source.pendingPush,
          pendingOps: source.pendingOps,
          migrationConflict: source.migrationConflict,
          lastReplicaPushError: source.lastReplicaPushError,
          cutoverBlocked: source.cutoverBlocked,
          cutoverBlockReason: source.cutoverBlockReason,
        }),
        manualUploadHold: source.manualUploadHold,
        schemaDrift: source.schemaDrift,
        rowsSyncing: rowsSyncing || undefined,
        syncMode: source.syncMode,
        online: source.online,
        pendingPush: source.pendingPush,
        pendingOps: source.pendingOps,
        migrationConflict: source.migrationConflict,
        lastReplicaPushError: source.lastReplicaPushError,
        cutoverBlocked: source.cutoverBlocked,
        cutoverBlockReason: source.cutoverBlockReason,
      };
    });

  const hasSchemaDrift = databases.some((db) => db.schemaDrift === true);
  const hasLinkedDatabases = databases.length > 0;
  const hasDependentJobs = dependentJobs.length > 0;
  const syncedJobCount = dependentJobs.filter((job) => job.phase === "synced").length;
  const totalJobCount = dependentJobs.length;
  const dbBlockingPending = databases.filter((db) => {
    const source = (items.turso?.sources ?? []).find(
      (s) => s.appId === appId && s.alias === db.alias,
    );
    return databaseBlocksOverallSync({
      status: db.status,
      schemaDrift: source?.schemaDrift,
      remoteTableCount: source?.remoteTableCount,
      manualUploadHold: db.manualUploadHold,
      syncMode: source?.syncMode,
      pendingPush: source?.pendingPush,
      migrationConflict: source?.migrationConflict,
      cutoverBlocked: source?.cutoverBlocked,
    });
  }).length;
  const dbRowsSyncing = databases.filter((db) => db.rowsSyncing).length;

  const registryDbIds =
    options?.registryDbIds ?? items.appContext?.registryDbIds ?? [];
  const hasRegistryDatabases = registryDbIds.length > 0;
  // Registry ships beside data-sources.json as apps/{id}/linked-databases.json.
  let registryPhase: AppCloudItemPhase = "synced";
  if (!hasRegistryDatabases) {
    registryPhase = "synced";
  } else if (codePhase === "synced") {
    registryPhase = "synced";
  } else if (
    (isUploading || codePhase === "uploading") &&
    !uploadQueuedEarly
  ) {
    registryPhase = "uploading";
  } else if (codePhase === "not_uploaded") {
    registryPhase = "not_uploaded";
  } else {
    registryPhase = "changed";
  }
  const registryNeedsSync = hasRegistryDatabases && registryPhase !== "synced";
  const registryLabel = appSync
    ? registryLabelForAppSync(hasRegistryDatabases, registryPhase)
    : !hasRegistryDatabases
      ? "No registry databases"
      : registryPhase === "synced"
        ? "Registry on the web"
        : codePhase === "not_uploaded"
          ? "Registry not on web yet"
          : "Registry uploads with app code";

  const codePhaseDisplay =
    clientPushActive && codePhase !== "synced"
      ? "uploading"
      : codePhase;
  if (!appSync) {
    codeLabel = codeDetail(
      codePhaseDisplay,
      codeStatus,
      githubItem?.manualUploadHold,
      githubItem?.lastError,
    );
  } else if (codePhaseDisplay === "uploading" && codePhase !== "uploading") {
    codeLabel = "Uploading app code to cloud repo…";
  }

  const publishLive = items.appContext?.publishLive === true;
  const oversizedAppFilesMessage = items.oversizedAppFiles?.message ?? null;
  const oversizedAppFilesCount = items.oversizedAppFiles?.paths.length ?? 0;
  const publishedAt = items.appContext?.publishedAt ?? null;

  const publishStatus: AppCloudPublishStatus =
    items.publish?.status ?? "synced";
  const publishDetail = items.publish?.detail ?? null;
  const publishLabel = publishDetailLabel(publishStatus, publishDetail);
  const cloudPublishing = publishStatus === "republishing";
  const publishLayerSynced =
    publishLive && publishStatus === "synced" && !cloudPublishing;
  const publishBlocksWeb =
    publishStatus === "drift" ||
    publishStatus === "error" ||
    (publishStatus === "not_web_ready" && !publishLive);

  const uploadStatus = items.upload?.status;
  const uploadLabel = items.upload?.label ?? null;
  const uploadDetail = items.upload?.detail ?? null;
  const uploadRetryPending = items.upload?.retryPending ?? false;
  const uploadQueued = items.upload?.waitingReason === "queued";
  const uploadQueuePosition = items.upload?.queuePosition ?? null;
  const uploadQueueDepth = items.upload?.queueDepth ?? null;
  const coordinatorUploading = uploadStatus === "uploading";
  const coordinatorWaiting = uploadStatus === "waiting";
  const coordinatorFailed = uploadStatus === "failed";

  const isQueuedForUpload = uploadQueued;
  const syncedOnWebNoLocalWork =
    (codePhase === "synced" ||
      (publishLive && codePhase === "not_uploaded" && codeStatus === "pending")) &&
    (appSync == null ||
      (appSync.phase === "synced" && appSync.hasLocalChanges !== true)) &&
    dbBlockingPending === 0 &&
    dependentJobs.every((job) => job.phase === "synced") &&
    !registryNeedsSync;
  const effectiveQueuedForUpload =
    isQueuedForUpload && !syncedOnWebNoLocalWork;
  const coordinatorAffectsUi =
    !publishLayerSynced &&
    !(isQueuedForUpload && syncedOnWebNoLocalWork) &&
    (coordinatorUploading || coordinatorWaiting || coordinatorFailed);
  const isActivelyUploading =
    !effectiveQueuedForUpload &&
    (clientPushActive ||
      (coordinatorUploading && !publishLayerSynced) ||
      (codePhaseDisplay === "uploading" && !publishLayerSynced) ||
      dependentJobs.some((job) => job.phase === "uploading"));

  let displayCodePhase = codePhaseDisplay;
  let displayRegistryPhase = registryPhase;
  let displayRegistryLabel = registryLabel;
  let displayRegistryNeedsSync = registryNeedsSync;

  if (publishLive && !isActivelyUploading) {
    if (codePhase === "not_uploaded" && codeStatus === "pending") {
      displayCodePhase = "synced";
      codeLabel = appSync?.label ?? "App code on the web";
    }
    if (registryPhase === "not_uploaded") {
      displayRegistryPhase = "synced";
      displayRegistryLabel = "Registry on the web";
      displayRegistryNeedsSync = false;
    }
  }

  const lastUploadedAt =
    appSync?.lastUploadedAt ??
    githubItem?.lastSyncAt ??
    publishedAt ??
    null;

  const needsSync =
    codePhase === "changed" ||
    (codePhase === "not_uploaded" && !publishLive) ||
    codeStatus === "failed" ||
    (coordinatorFailed && !publishLayerSynced) ||
    (coordinatorWaiting &&
      !publishLayerSynced &&
      !(isQueuedForUpload && syncedOnWebNoLocalWork)) ||
    dependentJobs.some(
      (job) =>
        job.phase === "changed" ||
        job.phase === "not_uploaded" ||
        job.status === "failed",
    ) ||
    dbBlockingPending > 0 ||
    displayRegistryNeedsSync ||
    (!publishLayerSynced &&
      displayCodePhase === "synced" &&
      dbBlockingPending === 0 &&
      !displayRegistryNeedsSync);

  let overall: AppCloudSyncOverall = "unknown";
  if (effectiveQueuedForUpload) {
    overall = "needs_sync";
  } else if (isActivelyUploading) {
    overall = "uploading";
  } else if (
    gitRemoteRequiresReview ||
    needsSync ||
    publishBlocksWeb ||
    displayCodePhase === "changed" ||
    (displayCodePhase === "not_uploaded" && !publishLive)
  ) {
    overall = "needs_sync";
  } else if (
    displayCodePhase === "synced" &&
    dependentJobs.every((job) => job.phase === "synced") &&
    dbBlockingPending === 0 &&
    !displayRegistryNeedsSync &&
    publishLayerSynced &&
    (!coordinatorWaiting ||
      publishLayerSynced ||
      (isQueuedForUpload && syncedOnWebNoLocalWork)) &&
    (!(coordinatorFailed && !uploadRetryPending) || publishLayerSynced)
  ) {
    overall = "synced";
  }

  let chipLabel = "Sync status";
  if (coordinatorFailed && !uploadRetryPending) {
    chipLabel = "Upload failed";
  } else if (codeStatus === "failed") {
    chipLabel = "Upload failed";
  } else if (writerConflict) {
    chipLabel = "Conflict on the web";
  } else if (gitRemoteRequiresReview) {
    chipLabel = "Merge required";
  } else if (gitRemoteMetadataSync) {
    chipLabel = "Syncing job status…";
  } else if (cloudPublishing || publishStatus === "republishing") {
    chipLabel = "Updating cloud…";
  } else if (coordinatorUploading && uploadLabel) {
    chipLabel = uploadLabel;
  } else if (effectiveQueuedForUpload && uploadLabel) {
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
  } else if (overall === "unknown") {
    chipLabel = "Sync status unknown";
  }

  const summaryLine =
    overall === "unknown"
      ? "Could not determine web sync status — open for details"
      : buildSummaryLine({
          codePhase: displayCodePhase,
          syncedJobCount,
          totalJobCount,
          dbBlockingPending,
          dbRowsSyncing,
          registryNeedsSync: displayRegistryNeedsSync,
          isActivelyUploading,
          isQueuedForUpload: effectiveQueuedForUpload,
          uploadQueuePosition,
          uploadQueueDepth,
          overall,
          lastUploadedAt,
          publishStatus,
          publishDetail,
          gitRemoteRequiresReview,
          gitRemoteMetadataSync,
          uploadLabel,
        });

  return {
    overall,
    codeStatus,
    codePhase: displayCodePhase,
    codeLabel,
    lastUploadedAt,
    dependentJobs,
    hasDependentJobs,
    syncedJobCount,
    totalJobCount,
    summaryLine,
    databases,
    hasSchemaDrift,
    hasLinkedDatabases,
    hasRegistryDatabases,
    registryPhase: displayRegistryPhase,
    registryLabel: displayRegistryLabel,
    chipLabel,
    globallySyncing,
    cloudPublishing,
    publishStatus,
    publishLabel,
    publishDetail,
    uploadStatus: coordinatorAffectsUi ? uploadStatus : undefined,
    uploadLabel: coordinatorAffectsUi ? uploadLabel : null,
    uploadDetail: coordinatorAffectsUi ? uploadDetail : null,
    uploadRetryPending: coordinatorAffectsUi ? uploadRetryPending : undefined,
    uploadQueued: coordinatorAffectsUi ? effectiveQueuedForUpload : undefined,
    uploadQueuePosition: coordinatorAffectsUi ? uploadQueuePosition : null,
    uploadQueueDepth: coordinatorAffectsUi ? uploadQueueDepth : null,
    gitUpdatesAvailable,
    gitUpdatesSummary,
    writerConflict,
    gitRemoteRequiresReview,
    gitRemoteMetadataSync,
    gitRemoteReviewHeadline,
    codeLastError: codeLastError ?? githubItem?.lastError ?? null,
    publishLive,
    oversizedAppFilesMessage,
    oversizedAppFilesCount,
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
  if (options.loading || !status) {
    return "Checking what's on the web…";
  }
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
  if (status.codeStatus === "failed" && !status.writerConflict) return "error";
  if (status.writerConflict || status.gitRemoteRequiresReview) return "action_required";
  if (options.pushing || status.overall === "uploading") return "syncing";
  if (status.oversizedAppFilesCount && status.oversizedAppFilesCount > 0) {
    return "warn";
  }
  if (status.overall === "synced") return "synced";
  if (
    status.publishStatus === "not_web_ready" ||
    status.publishStatus === "drift" ||
    status.publishStatus === "error"
  ) {
    return "warn";
  }
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
