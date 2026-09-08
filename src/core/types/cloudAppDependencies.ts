/**
 * Cross-app dependency declarations for cloud publish / community install.
 */

export const CLOUD_APP_DEPENDENCIES_FILENAME = "papr-cloud-dependencies.json";

export interface CloudAppDependencyRef {
  appId: string;
  /** Human label when slug is unavailable locally */
  title?: string;
  slug?: string;
  required: boolean;
  /** Features gated when this dependency is not installed */
  enables?: string[];
}

export interface CloudDatabaseDependencyRef {
  dbId: string;
  alias?: string;
  ownerAppId: string;
  ownerTitle?: string;
  ownerSlug?: string;
  required: boolean;
  enables?: string[];
}

export interface CloudAppDependenciesFile {
  schemaVersion: "1.0.0";
  updatedAt: string;
  apps: CloudAppDependencyRef[];
  databases: CloudDatabaseDependencyRef[];
}

export interface CloudInstallHealthReport {
  ok: boolean;
  expectedJobIds: string[];
  registeredJobIds: string[];
  missingJobIds: string[];
  expectedDbIds: string[];
  registeredDbIds: string[];
  missingRequiredDbIds: string[];
  warnings: string[];
}

export interface PublishReconcileReport {
  changed: boolean;
  removedJobIds: string[];
  removedDbIds: string[];
  addedJobIds: string[];
  warnings: string[];
}

/** Per-app dependency status for the publish share sheet. */
export interface CloudDependencyAppStatus {
  appId: string;
  title?: string;
  slug?: string;
  required: boolean;
  enables?: string[];
  /** Dependency app exists in this workspace. */
  localAppExists: boolean;
  /** Listed in Community Apps (public_read). */
  publishedToCommunity: boolean;
}

export interface CloudPublishReadinessReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  reconcile: PublishReconcileReport;
  dependencies: {
    apps: CloudDependencyAppStatus[];
    databases: CloudDatabaseDependencyRef[];
  };
  /** Copy-paste blurb for Community listing / README. */
  copyInstallNote: string | null;
}

/** Runtime feature gate for mini-apps (optional cross-app deps). */
export interface FeatureAvailabilityEntry {
  available: boolean;
  reason?: string;
  installSlug?: string;
  ownerTitle?: string;
  ownerAppId?: string;
}

export interface AppFeatureAvailabilityReport {
  appId: string;
  /** Keys are stable slugs derived from dependency app slug or database alias. */
  features: Record<string, FeatureAvailabilityEntry>;
  optionalApps: Array<{
    appId: string;
    title?: string;
    slug?: string;
    installed: boolean;
    enables?: string[];
  }>;
}
