/**
 * User-friendly upload progress for /api/sync/items (non-technical copy).
 */

import type { SyncCoordinator } from "./SyncCoordinator.js";

export type CoordinatorUploadStatus =
  | "idle"
  | "uploading"
  | "waiting"
  | "failed";

export interface CoordinatorStatusReport {
  status: CoordinatorUploadStatus;
  /** Short label for chips and list rows */
  label: string;
  /** Optional longer explanation for popovers */
  detail?: string;
  appId?: string;
  /** True when auto-upload will retry without user action. */
  retryPending?: boolean;
}

export function buildCoordinatorStatusReport(
  coordinator: SyncCoordinator | null,
  appId?: string,
): CoordinatorStatusReport | null {
  if (!coordinator) {
    return null;
  }

  const raw = coordinator.getStatus(appId);
  const flushError = appId
    ? (raw.flushErrors[appId] ??
      coordinator.getFlushError(appId) ??
      null)
    : Object.values(raw.flushErrors)[0] ?? null;

  if (raw.activeFlush && (!appId || raw.activeFlush.appId === appId)) {
    return {
      status: "uploading",
      label: "Updating for the web…",
      detail: "Database → app files → live link check.",
      appId: raw.activeFlush.appId,
    };
  }

  if (appId && raw.inFlightAppIds.includes(appId)) {
    return {
      status: "uploading",
      label: "Upload in progress…",
      detail: "Usually under a minute.",
      appId,
    };
  }

  if (appId && raw.queuedFlushAppIds.includes(appId) && !raw.inFlightAppIds.includes(appId)) {
    return {
      status: "waiting",
      label: "Queued for upload…",
      detail: "Other apps are uploading first.",
      appId,
    };
  }

  if (flushError) {
    return {
      status: "failed",
      label: flushError.retryPending ? "Upload failed — retrying" : "Upload failed",
      detail: flushError.retryPending
        ? `${flushError.message.slice(0, 120)} Retrying automatically.`
        : `${flushError.message.slice(0, 160)} Use Upload now to retry.`,
      appId,
      retryPending: flushError.retryPending,
    };
  }

  const gitDirtyForApp = appId
    ? raw.gitDirtyAppIds.includes(appId)
    : raw.gitDirtyAppIds.length > 0;
  // getStatus(appId) already scopes dbDirtySyncKeys to this app when appId is set.
  const dbDirty = raw.dbDirtySyncKeys.length > 0;

  if (gitDirtyForApp || dbDirty) {
    let detail: string;
    if (gitDirtyForApp && dbDirty) {
      detail =
        "You have local app and database changes that are not on the web yet.";
    } else if (dbDirty) {
      detail = "Database changes are waiting to sync to the web.";
    } else {
      detail = "App file changes are waiting to upload.";
    }
    return {
      status: "waiting",
      label: "Changes waiting to upload",
      detail,
      ...(appId ? { appId } : {}),
    };
  }

  return {
    status: "idle",
    label: "Nothing uploading right now",
  };
}
