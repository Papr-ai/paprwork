export type LegacyPathIssueKind =
  | "flat_legacy_location"
  | "hardcoded_command_path"
  | "hardcoded_source_path"
  | "stale_data_source_db_path"
  | "missing_job_folder"
  | "missing_app_folder"
  | "missing_linked_job_folder"
  | "resource_found_elsewhere";

export interface LegacyPathIssue {
  kind: LegacyPathIssueKind;
  summary: string;
  detail?: string;
  filePath?: string;
}

export interface JobLegacyPathHealth {
  jobId: string;
  jobName: string;
  jobDir: string;
  issues: LegacyPathIssue[];
}

export interface AppLegacyPathHealth {
  appId: string;
  appTitle: string;
  appPath: string;
  issues: LegacyPathIssue[];
}

export interface LegacyPathHealthScanResult {
  scannedAt: string;
  activePaprHome: string;
  jobs: JobLegacyPathHealth[];
  apps: AppLegacyPathHealth[];
  jobIssueCount: number;
  appIssueCount: number;
}
