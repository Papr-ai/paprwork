/**
 * Per-app cloud sync status derived from gateway /api/sync/items.
 */

import type { SyncItemsResponse } from "../components/Settings/CloudSyncDetails";

export type AppCloudSyncOverall =
  | "synced"
  | "uploading"
  | "needs_sync"
  | "disabled"
  | "unknown";

/** @deprecated Use AppCloudSyncOverall — kept for gradual migration */
export type AppCloudSyncOverallLegacy = AppCloudSyncOverall | "syncing" | "outdated";

export type AppCloudCodeStatus = "synced" | "pending" | "outdated" | "unknown";

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
}

export interface AppCloudDatabaseStatus {
  alias: string;
  jobId: string;
  status: "synced" | "pending" | "empty" | "unavailable";
  phase: AppCloudItemPhase;
  detail: string;
}

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
  chipLabel: string;
  globallySyncing: boolean;
  /** Auto-republish after git push (publish catalog / vault allowlist). */
  cloudPublishing: boolean;
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
  if (status === "outdated") return "changed";
  if (status === "pending" && !lastSyncAt) return "not_uploaded";
  if (status === "pending") return "changed";
  return "changed";
}

function codeDetail(phase: AppCloudItemPhase): string {
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

function jobDetail(phase: AppCloudItemPhase): string {
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
}): string {
  switch (item.status) {
    case "synced":
      return `${item.remoteTableCount} table(s) on Turso`;
    case "pending":
      return item.remoteTableCount > 0
        ? "Local DB changes not on Turso yet"
        : `${item.localTableCount} local table(s) not on Turso yet`;
    case "empty":
      return "No data tables yet";
    case "unavailable":
      return "Database unavailable";
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
    case "unavailable":
      return "changed";
    default:
      return "changed";
  }
}

function buildSummaryLine(opts: {
  codePhase: AppCloudItemPhase;
  syncedJobCount: number;
  totalJobCount: number;
  dbPending: number;
  isUploading: boolean;
}): string {
  const { codePhase, syncedJobCount, totalJobCount, dbPending, isUploading } =
    opts;

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
  if (codePhase === "changed" || codePhase === "not_uploaded") {
    parts.push("app code not on web yet");
  }
  if (dbPending > 0) {
    parts.push(`${dbPending} database(s) need Turso sync`);
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
      chipLabel: "Cloud off",
      globallySyncing: false,
      cloudPublishing: false,
    };
  }

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
        detail: jobDetail(phase),
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
        detail: databaseDetail(source),
      };
    });

  const hasLinkedDatabases = databases.length > 0;
  const hasDependentJobs = dependentJobs.length > 0;
  const syncedJobCount = dependentJobs.filter((job) => job.phase === "synced").length;
  const totalJobCount = dependentJobs.length;
  const dbPending = databases.filter((db) => db.status === "pending").length;

  const codePhaseDisplay =
    isUploading && codePhase !== "synced" ? "uploading" : codePhase;
  const codeLabel = codeDetail(codePhaseDisplay);

  const anyUploading =
    isUploading ||
    codePhaseDisplay === "uploading" ||
    dependentJobs.some((job) => job.phase === "uploading");

  const needsSync =
    codePhase === "changed" ||
    codePhase === "not_uploaded" ||
    dependentJobs.some(
      (job) => job.phase === "changed" || job.phase === "not_uploaded",
    ) ||
    dbPending > 0;

  let overall: AppCloudSyncOverall = "unknown";
  if (anyUploading) {
    overall = "uploading";
  } else if (
    needsSync ||
    codePhase === "changed" ||
    codePhase === "not_uploaded"
  ) {
    overall = "needs_sync";
  } else if (
    codePhase === "synced" &&
    dependentJobs.every((job) => job.phase === "synced") &&
    dbPending === 0
  ) {
    overall = "synced";
  } else if (needsSync) {
    overall = "needs_sync";
  }

  let chipLabel = "Sync status";
  if (cloudPublishing && overall === "synced") {
    chipLabel = "Updating cloud…";
  } else if (overall === "synced") chipLabel = "Synced";
  else if (overall === "uploading") {
    chipLabel =
      totalJobCount > 0
        ? `Uploading ${syncedJobCount}/${totalJobCount}…`
        : "Uploading…";
  } else if (overall === "needs_sync") {
    chipLabel =
      totalJobCount > 0
        ? `Needs sync (${syncedJobCount}/${totalJobCount})`
        : "Needs sync";
  } else if (overall === "disabled") chipLabel = "Cloud off";

  const summaryLine = buildSummaryLine({
    codePhase: codePhaseDisplay,
    syncedJobCount,
    totalJobCount,
    dbPending,
    isUploading: anyUploading,
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
    chipLabel,
    globallySyncing,
    cloudPublishing,
  };
}
