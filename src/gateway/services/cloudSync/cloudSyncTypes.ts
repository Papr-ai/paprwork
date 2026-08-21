/** Result of a scoped Sync V3 push (writer ops + workspace log). */
export interface PushGitScopedResult {
  pushedPaths: string[];
  skippedPaths: string[];
  scope: "workspace" | "app" | "job";
  appId?: string;
  jobId?: string;
}

export type SyncStatus = "idle" | "syncing" | "queuing" | "error";

export interface ManualFlushErrorRecord {
  message: string;
  at: string;
  kind?: "conflict" | "error";
  conflictPaths?: string[];
}

export interface CloudSyncPublicState {
  status: SyncStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  repoUrl: string | null;
  queueRemaining: number;
  queueTotal: number;
  cloudPublishing: boolean;
  cloudPublishingAppIds: string[];
  gitUpdatesAvailable: boolean;
  gitUpdatesSummary: string | null;
  gitRemoteChangedPaths: string[] | null;
  gitHistoryDiverged: boolean;
  gitLocalAheadCount: number;
  gitRemoteBehindCount: number;
  manualFlushErrors: Record<string, ManualFlushErrorRecord>;
}
