/**
 * User-friendly upload progress for /api/sync/items (non-technical copy).
 */

import type { SyncCoordinator } from "./SyncCoordinator.js";
import {
  formatFlushQueueDetail,
  formatFlushQueueLabel,
} from "./flushQueueCopy.js";

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
  /** Set when status is waiting because the app is in the flush queue. */
  waitingReason?: "queued" | "dirty";
  /** 1-based position in the global upload queue (includes active upload). */
  queuePosition?: number;
  /** Total apps uploading or waiting (active + queued). */
  queueDepth?: number;
}

function resolveFlushQueuePosition(
  coordinator: SyncCoordinator,
  appId: string,
): { position: number; depth: number } | null {
  const workspace = coordinator.getStatus();
  const index = workspace.queuedFlushAppIds.indexOf(appId);
  if (index < 0) {
    return null;
  }
  const depth =
    workspace.queuedFlushAppIds.length + (workspace.activeFlush ? 1 : 0);
  const position = (workspace.activeFlush ? 1 : 0) + index + 1;
  return { position, depth };
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

  if (appId && raw.queuedFlushAppIds.includes(appId)) {
    // App may remain in the serial queue until drain runs; hide queue UI when it has no work.
    if (coordinator.needsOrderedFlush(appId)) {
      const queue = resolveFlushQueuePosition(coordinator, appId);
      return {
        status: "waiting",
        waitingReason: "queued",
        queuePosition: queue?.position,
        queueDepth: queue?.depth,
        label:
          queue && queue.depth > 0
            ? formatFlushQueueLabel(queue.position, queue.depth)
            : "Queued for upload…",
        detail:
          queue && queue.depth > 0
            ? formatFlushQueueDetail(queue.position, queue.depth)
            : "Waiting in upload queue…",
        appId,
      };
    }
  }

  if (flushError) {
    const isConflict = flushError.kind === "conflict";
    return {
      status: "failed",
      label: isConflict
        ? "File changed on the web"
        : flushError.retryPending
          ? "Upload failed — retrying"
          : "Upload failed",
      detail: isConflict
        ? `These paths changed on the server: ${(flushError.conflictPaths ?? []).join(", ").slice(0, 160) || flushError.message.slice(0, 160)}. Use Upload now after reviewing.`
        : flushError.retryPending
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
      waitingReason: "dirty",
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
